import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from '../task/tool-context.js';
import { RunManager } from '../task/run-manager.js';
import { ArtifactStore } from '../task/artifact-store.js';
import { ErrorCode } from '../task/error-codes.js';
import { getTemplate, listTemplates } from '../task/templates/registry.js';
import { executeBatchExtract } from '../task/templates/batch-extract.js';
import type { BatchExtractInputs } from '../task/templates/batch-extract.js';
import { executeLoginKeepSession, LOGIN_TOTAL_STEPS } from '../task/templates/login-keep-session.js';
import type { LoginKeepSessionInputs } from '../task/templates/login-keep-session.js';
import { executeMultiTabCompare } from '../task/templates/multi-tab-compare.js';
import type { MultiTabCompareInputs } from '../task/templates/multi-tab-compare.js';
import type { CancelToken } from '../task/cancel-token.js';
import { enrichWithAiMarkdown } from './ai-markdown.js';

function textResult(data: unknown, toolName?: string) {
  const payload = toolName ? enrichWithAiMarkdown(toolName, data) : data;
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

function makeError(message: string, code: ErrorCode): Error {
  const err = new Error(message);
  (err as any).errorCode = code;
  return err;
}

function summarizeResult(result: unknown): string {
  if (result === null || result === undefined) return 'No result payload';
  if (typeof result === 'string') return result.slice(0, 240);
  if (typeof result === 'number' || typeof result === 'boolean') return String(result);
  if (Array.isArray(result)) return `Array(${result.length})`;
  if (typeof result === 'object') {
    const keys = Object.keys(result as Record<string, unknown>);
    return keys.length > 0
      ? `Object with keys: ${keys.slice(0, 10).join(', ')}`
      : 'Empty object';
  }
  return String(result);
}

function buildEvidenceRefs(artifactIds: string[]): Array<{ artifactId: string; reason: string }> {
  return artifactIds.map((artifactId, index) => ({
    artifactId,
    reason: index === 0 ? 'primary_result' : 'additional_evidence',
  }));
}

type VerificationSnapshot = {
  pass: boolean;
  score?: number;
  missingFields: string[];
  typeMismatches: string[];
  reason?: string;
};

function extractVerification(result: unknown, errorDetails: unknown): VerificationSnapshot | null {
  const fromResultObject = normalizeVerificationCandidate(result);
  if (fromResultObject) return fromResultObject;

  const resultObj = asRecord(result);
  const nestedInResult = normalizeVerificationCandidate(resultObj?.verification);
  if (nestedInResult) return nestedInResult;

  const errObj = asRecord(errorDetails);
  const nestedInError = normalizeVerificationCandidate(errObj?.verification);
  if (nestedInError) return nestedInError;

  return null;
}

function normalizeVerificationCandidate(value: unknown): VerificationSnapshot | null {
  const rec = asRecord(value);
  if (!rec) return null;

  if (typeof rec.pass !== 'boolean') return null;

  const missingFields = Array.isArray(rec.missingFields)
    ? rec.missingFields.map((item) => String(item)).filter(Boolean)
    : [];
  const typeMismatches = Array.isArray(rec.typeMismatches)
    ? rec.typeMismatches.map((item) => String(item)).filter(Boolean)
    : [];

  return {
    pass: rec.pass,
    score: typeof rec.score === 'number' ? rec.score : undefined,
    missingFields,
    typeMismatches,
    reason: typeof rec.reason === 'string' ? rec.reason : undefined,
  };
}

function buildSchemaRepairHints(verification: VerificationSnapshot | null): string[] {
  if (!verification || verification.pass) return [];

  const hints: string[] = [];
  if (verification.missingFields.length > 0) {
    hints.push(`Missing fields: ${verification.missingFields.slice(0, 8).join(', ')}`);
  }
  if (verification.typeMismatches.length > 0) {
    hints.push(`Type mismatches: ${verification.typeMismatches.slice(0, 8).join(', ')}`);
  }
  hints.push('For missing fields, collect more page content or element signals before retrying.');
  hints.push('For type mismatches, normalize result value types to match output schema.');
  return hints;
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

const RUN_STATUSES = [
  'queued', 'running', 'succeeded', 'failed', 'partial_success', 'canceled',
] as const;

const RUN_MODES = ['sync', 'async', 'auto'] as const;

export function registerTaskTools(
  server: McpServer,
  toolCtx: ToolContext,
  runManager: RunManager,
  artifactStore: ArtifactStore,
  isRemote: boolean,
  safe: <T extends (...args: any[]) => Promise<any>>(fn: T) => T,
  resolveSession: (sessionId?: string) => Promise<string>,
  createIsolatedSession: () => Promise<string>,
): void {

  // ===== list_task_templates =====

  server.tool(
    'list_task_templates',
    '列出可用的任务模板',
    {},
    safe(async () => {
      const templates = listTemplates();
      return textResult({
        templates: templates.map((t) => ({
          templateId: t.templateId,
          version: t.version,
          name: t.name,
          description: t.description,
          trustLevelSupport: t.trustLevelSupport,
          executionMode: t.executionMode,
          limits: t.limits,
        })),
        hasMore: false,
        nextCursor: null,
      }, 'list_task_templates');
    })
  );

  // ===== run_task_template =====

  server.tool(
    'run_task_template',
    '运行任务模板（支持 sync/async/auto；不传 sessionId 时自动创建隔离会话）',
    {
      templateId: z.string().describe('模板ID，如 batch_extract_pages'),
      sessionId: z.string().optional().describe('会话ID，不传则自动创建'),
      inputs: z.record(z.any()).describe('模板输入参数（字段因 templateId 而异，建议先调用 list_task_templates 获取模板能力）'),
      options: z.object({
        timeoutMs: z.number().optional().describe('执行超时（毫秒）；sync/async 均生效，默认 300000，最大 600000'),
        mode: z.string().optional().describe('执行模式：sync / async / auto，默认 auto'),
      }).optional(),
    },
    safe(async ({ templateId, sessionId: rawSessionId, inputs, options: opts }) => {
      // Look up template from registry
      const meta = getTemplate(templateId);
      if (!meta) {
        throw makeError(`Template not found: ${templateId}`, ErrorCode.TEMPLATE_NOT_FOUND);
      }

      // Check trust level
      if (!meta.trustLevelSupport.includes(toolCtx.trustLevel)) {
        throw makeError(
          `Template '${templateId}' does not support trust level '${toolCtx.trustLevel}'`,
          ErrorCode.TRUST_LEVEL_NOT_ALLOWED,
        );
      }

      const timeoutMs = opts?.timeoutMs;
      if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)) {
        throw makeError('options.timeoutMs must be an integer between 1 and 600000', ErrorCode.INVALID_PARAMETER);
      }

      const modeInput = opts?.mode ?? 'auto';
      if (!RUN_MODES.includes(modeInput as any)) {
        throw makeError('options.mode must be one of: sync, async, auto', ErrorCode.INVALID_PARAMETER);
      }

      // Template-specific input validation
      if (templateId === 'batch_extract_pages') {
        const batchInputs = inputs as BatchExtractInputs;
        if (!batchInputs.urls || !Array.isArray(batchInputs.urls) || batchInputs.urls.length === 0) {
          throw makeError('inputs.urls must be a non-empty array of URLs', ErrorCode.INVALID_PARAMETER);
        }
        if (batchInputs.urls.length > 1000) {
          throw makeError('inputs.urls exceeds maximum of 1000 URLs', ErrorCode.INVALID_PARAMETER);
        }
        if (batchInputs.concurrency !== undefined && (!Number.isInteger(batchInputs.concurrency) || batchInputs.concurrency < 1 || batchInputs.concurrency > 5)) {
          throw makeError('inputs.concurrency must be an integer between 1 and 5', ErrorCode.INVALID_PARAMETER);
        }
      } else if (templateId === 'multi_tab_compare') {
        const compareInputs = inputs as MultiTabCompareInputs;
        if (!compareInputs.urls || !Array.isArray(compareInputs.urls) || compareInputs.urls.length === 0) {
          throw makeError('inputs.urls must be a non-empty array of URLs', ErrorCode.INVALID_PARAMETER);
        }
        if (compareInputs.urls.length > 10) {
          throw makeError('inputs.urls exceeds maximum of 10 URLs', ErrorCode.INVALID_PARAMETER);
        }
        if (compareInputs.concurrency !== undefined && (!Number.isInteger(compareInputs.concurrency) || compareInputs.concurrency < 1 || compareInputs.concurrency > 5)) {
          throw makeError('inputs.concurrency must be an integer between 1 and 5', ErrorCode.INVALID_PARAMETER);
        }

        const fields = compareInputs.compare?.fields ?? ['title', 'elementCount', 'topSections'];
        const needsPageInfo = fields.includes('title') || fields.includes('elementCount');
        const needsContent = fields.includes('topSections');

        if (compareInputs.extract?.pageInfo === false && needsPageInfo) {
          throw makeError(
            'inputs.extract.pageInfo=false is incompatible with compare.fields including title/elementCount',
            ErrorCode.INVALID_PARAMETER,
          );
        }
        if (compareInputs.extract?.content === false && needsContent) {
          throw makeError(
            'inputs.extract.content=false is incompatible with compare.fields including topSections',
            ErrorCode.INVALID_PARAMETER,
          );
        }
      }

      // Resolve session
      const ownsSession = !rawSessionId;
      const sessionId = ownsSession ? await createIsolatedSession() : await resolveSession(rawSessionId);

      // Determine totalSteps based on template
      let totalSteps: number;
      if (templateId === 'batch_extract_pages') {
        totalSteps = (inputs as BatchExtractInputs).urls.length;
      } else if (templateId === 'login_keep_session') {
        totalSteps = LOGIN_TOTAL_STEPS;
      } else if (templateId === 'multi_tab_compare') {
        // urls.length extractions + 1 diff step
        totalSteps = (inputs as MultiTabCompareInputs).urls.length + 1;
      } else {
        totalSteps = 1;
      }

      // Determine execution mode
      const requestedMode = modeInput as 'sync' | 'async' | 'auto';
      let mode: 'sync' | 'async';
      if (requestedMode === 'auto') {
        if (templateId === 'login_keep_session') {
          mode = 'sync';
        } else if (templateId === 'batch_extract_pages') {
          mode = (inputs as BatchExtractInputs).urls.length <= 10 ? 'sync' : 'async';
        } else if (templateId === 'multi_tab_compare') {
          mode = 'sync';
        } else {
          mode = 'sync';
        }
      } else {
        mode = requestedMode;
      }

      // Build executor function based on templateId
      let executor: (runId: string, token: CancelToken, onProgress: (done: number) => void) => Promise<any>;

      if (templateId === 'batch_extract_pages') {
        executor = (_runId: string, token: CancelToken, onProgress: (done: number) => void) => {
          return executeBatchExtract(toolCtx, sessionId, inputs as BatchExtractInputs, onProgress, token);
        };
      } else if (templateId === 'login_keep_session') {
        executor = (_runId: string, token: CancelToken, onProgress: (done: number) => void) => {
          return executeLoginKeepSession(toolCtx, sessionId, inputs as LoginKeepSessionInputs, token, onProgress);
        };
      } else if (templateId === 'multi_tab_compare') {
        executor = (_runId: string, token: CancelToken, onProgress: (done: number) => void) => {
          return executeMultiTabCompare(toolCtx, sessionId, inputs as MultiTabCompareInputs, token, onProgress);
        };
      } else {
        throw makeError(`No executor for template: ${templateId}`, ErrorCode.TEMPLATE_NOT_FOUND);
      }

      const persistResultArtifact = (runId: string, result: unknown) => {
        if (result === undefined) return;
        const run = runManager.get(runId);
        if (!run || run.artifactIds.length > 0) return;
        const artifactId = artifactStore.save(runId, JSON.stringify(result), 'application/json');
        runManager.attachArtifact(runId, artifactId);
      };

      // Submit to RunManager
      const { runId, syncResult } = await runManager.submit(
        templateId,
        sessionId,
        ownsSession,
        totalSteps,
        executor,
        {
          timeoutMs,
          mode,
          onTerminal: async (run) => {
            persistResultArtifact(run.runId, run.result);
            artifactStore.markExpiring(run.runId);
            const shouldKeepOwnedSession = run.templateId === 'login_keep_session';
            if (run.ownsSession && !shouldKeepOwnedSession) {
              await toolCtx.sessionManager.close(run.sessionId).catch(() => {});
            }
          },
        },
      );

      // Return result based on mode
      if (mode === 'sync') {
        const run = runManager.get(runId);
        const sessionPreserved = templateId === 'login_keep_session' && ownsSession;
        return textResult({
          runId,
          sessionId,
          status: run?.status ?? 'succeeded',
          mode: 'sync',
          sessionPreserved,
          result: syncResult,
        }, 'run_task_template');
      }

      return textResult({
        runId,
        sessionId,
        status: 'queued',
        mode: 'async',
        sessionPreserved: templateId === 'login_keep_session' && ownsSession,
        poll: 'Use get_task_run to check progress',
      }, 'run_task_template');
    })
  );

  // ===== get_task_run =====

  server.tool(
    'get_task_run',
    '查询任务运行状态、进度、结果与产物引用',
    {
      runId: z.string().describe('运行ID，由 run_task_template 返回'),
    },
    safe(async ({ runId }) => {
      const run = runManager.get(runId);
      if (!run) {
        throw makeError(`Run not found: ${runId}`, ErrorCode.RUN_NOT_FOUND);
      }
      const verification = extractVerification(run.result, run.error?.details);
      return textResult({
        runId: run.runId,
        templateId: run.templateId,
        sessionId: run.sessionId,
        ownsSession: run.ownsSession,
        status: run.status,
        progress: run.progress,
        metrics: run.metrics,
        result: run.result,
        resultSummary: summarizeResult(run.result),
        verification,
        schemaRepairHints: buildSchemaRepairHints(verification),
        error: run.error,
        artifactIds: run.artifactIds,
        evidenceRefs: buildEvidenceRefs(run.artifactIds),
      }, 'get_task_run');
    })
  );

  // ===== list_task_runs =====

  server.tool(
    'list_task_runs',
    '列出任务运行记录（支持分页，total 为过滤后的总量）',
    {
      status: z.string().optional().describe('按状态过滤：queued, running, succeeded, failed, partial_success, canceled'),
      templateId: z.string().optional().describe('按模板ID过滤'),
      limit: z.number().optional().describe('返回条数，默认50'),
      offset: z.number().optional().describe('偏移量，默认0'),
    },
    safe(async ({ status, templateId, limit, offset }) => {
      if (status !== undefined && !RUN_STATUSES.includes(status as any)) {
        throw makeError('status must be one of: queued, running, succeeded, failed, partial_success, canceled', ErrorCode.INVALID_PARAMETER);
      }
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) {
        throw makeError('limit must be an integer between 1 and 1000', ErrorCode.INVALID_PARAMETER);
      }
      if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
        throw makeError('offset must be an integer greater than or equal to 0', ErrorCode.INVALID_PARAMETER);
      }

      const typedStatus = status as typeof RUN_STATUSES[number] | undefined;
      const normalizedOffset = offset ?? 0;
      const normalizedLimit = limit ?? 50;
      const runs = runManager.list({
        status: typedStatus,
        templateId,
        limit: normalizedLimit,
        offset: normalizedOffset,
      });
      const total = runManager.count({ status: typedStatus, templateId });
      const hasMore = normalizedOffset + runs.length < total;
      const nextCursor = hasMore
        ? { offset: normalizedOffset + runs.length, limit: normalizedLimit }
        : null;
      return textResult({
        runs: runs.map((r) => ({
          runId: r.runId,
          templateId: r.templateId,
          sessionId: r.sessionId,
          status: r.status,
          progress: r.progress,
          metrics: r.metrics,
          createdAt: r.createdAt,
          error: r.error,
          artifactIds: r.artifactIds,
        })),
        total,
        hasMore,
        nextCursor,
      }, 'list_task_runs');
    })
  );

  // ===== cancel_task_run =====

  server.tool(
    'cancel_task_run',
    '取消正在运行的任务',
    {
      runId: z.string().describe('要取消的运行ID'),
    },
    safe(async ({ runId }) => {
      const canceled = runManager.cancel(runId);
      if (!canceled) {
        const run = runManager.get(runId);
        if (!run) {
          throw makeError(`Run not found: ${runId}`, ErrorCode.RUN_NOT_FOUND);
        }
        return textResult({
          success: false,
          runId,
          reason: `Run is already in terminal state: ${run.status}`,
        }, 'cancel_task_run');
      }
      return textResult({ success: true, runId }, 'cancel_task_run');
    })
  );

  // ===== get_artifact =====

  server.tool(
    'get_artifact',
    '获取任务产物分片（文本返回原文，二进制返回 base64）',
    {
      artifactId: z.string().describe('产物ID'),
      offset: z.number().optional().describe('读取偏移量（字节），默认0'),
      limit: z.number().optional().describe('读取长度（字节），默认256KB，上限256KB'),
    },
    safe(async ({ artifactId, offset, limit }) => {
      const chunk = artifactStore.get(artifactId, offset, limit);
      if (!chunk) {
        throw makeError(`Artifact not found: ${artifactId}`, ErrorCode.ARTIFACT_NOT_FOUND);
      }
      return textResult(chunk, 'get_artifact');
    })
  );

  // ===== get_runtime_profile =====

  server.tool(
    'get_runtime_profile',
    '获取运行时限制和配置信息',
    {},
    safe(async () => {
      return textResult({
        maxConcurrentRuns: 5,
        maxUrls: 1000,
        maxTabsPerSession: 20,
        syncTimeoutMs: 300_000,
        asyncTimeoutMs: 600_000,
        artifactMaxChunkSize: 256 * 1024,
        artifactTtlMs: 24 * 60 * 60 * 1000,
        runTtlMs: 30 * 60 * 1000,
        trustLevel: toolCtx.trustLevel,
        isRemote,
        supportedModes: ['sync', 'async', 'auto'],
      }, 'get_runtime_profile');
    })
  );
}
