import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BrowserManager } from '../src/browser/BrowserManager.js';
import { SessionManager } from '../src/browser/SessionManager.js';
import { CookieStore } from '../src/browser/CookieStore.js';
import { registerRoutes } from '../src/api/routes.js';
import { createBrowserMcpServer } from '../src/mcp/browser-mcp-server.js';

function fixtureUrl(name: string): string {
  return `file://${path.resolve('tests/fixtures', name)}`;
}

type Scenario = {
  id: string;
  payload: Record<string, unknown>;
};

type ScenarioResult = {
  id: string;
  success: boolean;
  taskId?: string;
  traceId?: string;
  ttdMs?: number;
  noHumanIntervention: boolean;
  error?: string;
};

type AiFieldCoverage = {
  tool: string;
  ok: boolean;
  missingFields: string[];
};

type ActionAttempt = {
  sourceTool: string;
  tool: string;
  args: Record<string, unknown>;
  success: boolean;
  isInvalidCall: boolean;
  errorCode?: string;
  error?: string;
};

type AiReadabilityMetrics = {
  toolResponses: number;
  aiFieldCoverageRate: number;
  aiFieldCoverage: AiFieldCoverage[];
  followUpActionAttempts: number;
  invalidToolCallRate: number;
  followUpActionSuccessRate: number;
  followUpActions: ActionAttempt[];
};

type ToolInvocationResult = {
  isError: boolean;
  data: any;
};

type NextAction = {
  tool: string;
  args?: Record<string, unknown>;
  reason?: string;
  priority?: 'high' | 'medium' | 'low';
};

const REQUIRED_AI_FIELDS = [
  'aiSchemaVersion',
  'aiDetailLevel',
  'aiSummary',
  'aiMarkdown',
  'aiHints',
  'nextActions',
] as const;

const FOLLOW_UP_TOOLS = new Set([
  'get_task_run',
  'get_artifact',
  'list_task_runs',
  'get_console_logs',
  'get_network_logs',
]);

const SCENARIOS: Scenario[] = [
  {
    id: 'batch_article_1',
    payload: {
      goal: '批量抓取页面',
      inputs: { urls: [fixtureUrl('article.html')] },
      constraints: { maxDurationMs: 20000, maxSteps: 20 },
      budget: { maxRetries: 0, maxToolCalls: 100 },
    },
  },
  {
    id: 'batch_form_1',
    payload: {
      goal: '批量抓取页面',
      inputs: { urls: [fixtureUrl('form.html')] },
      constraints: { maxDurationMs: 20000, maxSteps: 20 },
      budget: { maxRetries: 0, maxToolCalls: 100 },
    },
  },
  {
    id: 'batch_select_1',
    payload: {
      goal: '批量抓取页面',
      inputs: { urls: [fixtureUrl('select.html')] },
      constraints: { maxDurationMs: 20000, maxSteps: 20 },
      budget: { maxRetries: 0, maxToolCalls: 100 },
    },
  },
  {
    id: 'batch_long_1',
    payload: {
      goal: '批量抓取页面',
      inputs: { urls: [fixtureUrl('long-page.html')] },
      constraints: { maxDurationMs: 20000, maxSteps: 20 },
      budget: { maxRetries: 0, maxToolCalls: 100 },
    },
  },
  {
    id: 'compare_article_form',
    payload: {
      goal: '对比两个页面差异',
      inputs: { urls: [fixtureUrl('article.html'), fixtureUrl('form.html')] },
      constraints: { maxDurationMs: 30000, maxSteps: 20 },
      budget: { maxRetries: 0, maxToolCalls: 120 },
    },
  },
  {
    id: 'compare_form_select',
    payload: {
      goal: 'compare page differences',
      inputs: { urls: [fixtureUrl('form.html'), fixtureUrl('select.html')] },
      constraints: { maxDurationMs: 30000, maxSteps: 20 },
      budget: { maxRetries: 0, maxToolCalls: 120 },
    },
  },
  {
    id: 'batch_2_urls',
    payload: {
      goal: '批量抓取页面',
      inputs: { urls: [fixtureUrl('article.html'), fixtureUrl('select.html')] },
      constraints: { maxDurationMs: 30000, maxSteps: 20 },
      budget: { maxRetries: 0, maxToolCalls: 120 },
    },
  },
  {
    id: 'batch_3_urls',
    payload: {
      goal: '批量抓取页面',
      inputs: { urls: [fixtureUrl('article.html'), fixtureUrl('form.html'), fixtureUrl('select.html')] },
      constraints: { maxDurationMs: 30000, maxSteps: 25 },
      budget: { maxRetries: 0, maxToolCalls: 150 },
    },
  },
  {
    id: 'compare_article_long',
    payload: {
      goal: '比较页面内容变化',
      inputs: { urls: [fixtureUrl('article.html'), fixtureUrl('long-page.html')] },
      constraints: { maxDurationMs: 30000, maxSteps: 20 },
      budget: { maxRetries: 0, maxToolCalls: 120 },
    },
  },
  {
    id: 'batch_login_page',
    payload: {
      goal: '批量抓取页面',
      inputs: { urls: [fixtureUrl('login.html')] },
      constraints: { maxDurationMs: 20000, maxSteps: 20 },
      budget: { maxRetries: 0, maxToolCalls: 100 },
    },
  },
];

async function pollTaskDone(app: ReturnType<typeof Fastify>, taskId: string, timeoutMs = 30000): Promise<any> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const res = await app.inject({ method: 'GET', url: `/v1/tasks/${taskId}` });
    if (res.statusCode !== 200) {
      throw new Error(`get task failed: ${res.statusCode} ${res.body}`);
    }
    const body = JSON.parse(res.body);
    if (body.status === 'done') {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`task ${taskId} timeout`);
}

async function runScenario(app: ReturnType<typeof Fastify>, scenario: Scenario): Promise<ScenarioResult> {
  const create = await app.inject({
    method: 'POST',
    url: '/v1/tasks',
    payload: scenario.payload,
  });
  if (create.statusCode !== 200) {
    return {
      id: scenario.id,
      success: false,
      noHumanIntervention: false,
      error: `create failed: ${create.statusCode} ${create.body}`,
    };
  }

  const created = JSON.parse(create.body);
  const taskId = created.taskId as string;
  const traceId = created.traceId as string;

  try {
    const done = await pollTaskDone(app, taskId);
    const taskResult = done.result;
    const success = Boolean(taskResult?.success);
    const ttdMs = typeof done.createdAt === 'number' && typeof done.updatedAt === 'number'
      ? done.updatedAt - done.createdAt
      : undefined;

    return {
      id: scenario.id,
      success,
      taskId,
      traceId,
      ttdMs,
      noHumanIntervention: true,
      error: success ? undefined : (taskResult?.error || done.error || 'task failed'),
    };
  } catch (err: any) {
    return {
      id: scenario.id,
      success: false,
      taskId,
      traceId,
      noHumanIntervention: false,
      error: err.message || 'poll failed',
    };
  }
}

function parseToolResult(result: any): any {
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function hasAiHelperFields(data: any): { ok: boolean; missingFields: string[] } {
  if (!data || typeof data !== 'object') {
    return {
      ok: false,
      missingFields: [...REQUIRED_AI_FIELDS],
    };
  }

  const missingFields = REQUIRED_AI_FIELDS.filter((field) => {
    if (!(field in data)) return true;
    if (field === 'aiHints' || field === 'nextActions') return !Array.isArray(data[field]);
    return data[field] === undefined || data[field] === null || data[field] === '';
  });

  return {
    ok: missingFields.length === 0,
    missingFields,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hasPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') {
    return /<[^>]+>/.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasPlaceholder(item));
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) => hasPlaceholder(item));
  }
  return false;
}

function collectExecutableFollowUpActions(sourceTool: string, data: any): NextAction[] {
  const nextActions = Array.isArray(data?.nextActions) ? data.nextActions : [];
  const collected: NextAction[] = [];

  for (const action of nextActions) {
    const tool = typeof action?.tool === 'string' ? action.tool : '';
    const args = action?.args;
    if (!tool || !FOLLOW_UP_TOOLS.has(tool)) continue;
    if (!args || typeof args !== 'object' || hasPlaceholder(args)) continue;

    collected.push({
      tool,
      args,
      reason: typeof action.reason === 'string' ? action.reason : undefined,
      priority: action.priority,
    });

    if (collected.length >= 1) break;
  }

  // eslint-disable-next-line no-console
  if (collected.length > 0) console.log(`[baseline][ai] ${sourceTool} -> follow-up ${collected[0].tool}`);

  return collected;
}

async function collectAiReadabilityMetrics(sessionManager: SessionManager): Promise<AiReadabilityMetrics> {
  let mcpServer: McpServer | null = null;
  let mcpClient: Client | null = null;

  const aiFieldCoverage: AiFieldCoverage[] = [];
  const followUpActionCandidates: Array<{ sourceTool: string; action: NextAction }> = [];
  const dedupe = new Set<string>();

  const callAndTrack = async (name: string, args: Record<string, unknown>): Promise<ToolInvocationResult> => {
    if (!mcpClient) throw new Error('MCP client not initialized');
    const raw = await mcpClient.callTool({ name, arguments: args });
    const data = parseToolResult(raw);

    const coverage = hasAiHelperFields(data);
    aiFieldCoverage.push({
      tool: name,
      ok: coverage.ok,
      missingFields: coverage.missingFields,
    });

    for (const action of collectExecutableFollowUpActions(name, data)) {
      const key = `${action.tool}:${stableJson(action.args ?? {})}`;
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      followUpActionCandidates.push({ sourceTool: name, action });
    }

    return {
      isError: Boolean(raw?.isError),
      data,
    };
  };

  try {
    mcpServer = createBrowserMcpServer(sessionManager, undefined, { urlValidation: { allowFile: true } });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(st);

    mcpClient = new Client({ name: 'baseline-metrics', version: '0.1.0' });
    await mcpClient.connect(ct);

    const created = await callAndTrack('create_session', {});
    const sessionId = created.data?.sessionId as string;
    if (!sessionId) {
      throw new Error('create_session did not return sessionId');
    }

    await callAndTrack('navigate', { sessionId, url: fixtureUrl('article.html') });
    await callAndTrack('get_page_info', { sessionId, maxElements: 100 });
    await callAndTrack('get_page_content', { sessionId, maxLength: 3000 });
    await callAndTrack('list_tabs', { sessionId });

    await callAndTrack('execute_javascript', {
      sessionId,
      script: "console.error('baseline-error-1'); console.warn('baseline-warn-1'); return true;",
    });
    await callAndTrack('get_console_logs', { sessionId, maxEntries: 1, level: 'all' });
    await callAndTrack('get_network_logs', { sessionId, maxEntries: 1 });

    await callAndTrack('run_task_template', {
      templateId: 'batch_extract_pages',
      inputs: { urls: [fixtureUrl('article.html')] },
      options: { mode: 'sync' },
    });

    const run2 = await callAndTrack('run_task_template', {
      templateId: 'batch_extract_pages',
      inputs: { urls: [fixtureUrl('form.html')] },
      options: { mode: 'sync' },
    });

    const run2Id = run2.data?.runId as string;
    if (run2Id) {
      const runInfo = await callAndTrack('get_task_run', { runId: run2Id });
      const firstArtifactId = Array.isArray(runInfo.data?.artifactIds) ? runInfo.data.artifactIds[0] : undefined;
      if (typeof firstArtifactId === 'string' && firstArtifactId) {
        await callAndTrack('get_artifact', { artifactId: firstArtifactId });
      }
    }

    await callAndTrack('list_task_runs', { limit: 1, offset: 0 });
    await callAndTrack('get_runtime_profile', {});
    await callAndTrack('close_session', { sessionId });

    const followUpActions: ActionAttempt[] = [];

    for (const candidate of followUpActionCandidates) {
      const raw = await mcpClient.callTool({
        name: candidate.action.tool,
        arguments: candidate.action.args ?? {},
      });
      const data = parseToolResult(raw);
      const errorCode = typeof data?.errorCode === 'string' ? data.errorCode : undefined;
      const error = typeof data?.error === 'string' ? data.error : undefined;
      followUpActions.push({
        sourceTool: candidate.sourceTool,
        tool: candidate.action.tool,
        args: candidate.action.args ?? {},
        success: !raw?.isError,
        isInvalidCall: errorCode === 'INVALID_PARAMETER',
        errorCode,
        error,
      });
    }

    const totalCoverage = aiFieldCoverage.length;
    const covered = aiFieldCoverage.filter((item) => item.ok).length;

    const totalActions = followUpActions.length;
    const invalidActions = followUpActions.filter((action) => action.isInvalidCall).length;
    const actionSuccess = followUpActions.filter((action) => action.success).length;

    return {
      toolResponses: totalCoverage,
      aiFieldCoverageRate: totalCoverage > 0 ? covered / totalCoverage : 0,
      aiFieldCoverage,
      followUpActionAttempts: totalActions,
      invalidToolCallRate: totalActions > 0 ? invalidActions / totalActions : 0,
      followUpActionSuccessRate: totalActions > 0 ? actionSuccess / totalActions : 1,
      followUpActions,
    };
  } finally {
    if (mcpClient) {
      await mcpClient.close().catch(() => {});
    }
    if (mcpServer) {
      await mcpServer.close().catch(() => {});
    }
  }
}

async function main() {
  const browserManager = new BrowserManager();
  await browserManager.launch({ headless: true });
  const sessionManager = new SessionManager(browserManager);

  const app = Fastify();
  registerRoutes(app, sessionManager, new CookieStore());
  await app.ready();

  const startedAt = Date.now();
  const results: ScenarioResult[] = [];
  let aiMetrics: AiReadabilityMetrics | null = null;

  try {
    for (const scenario of SCENARIOS) {
      // eslint-disable-next-line no-console
      console.log(`[baseline] running ${scenario.id}`);
      const result = await runScenario(app, scenario);
      results.push(result);
      // eslint-disable-next-line no-console
      console.log(`[baseline] ${scenario.id} -> ${result.success ? 'ok' : 'fail'}${result.error ? ` (${result.error})` : ''}`);
    }

    aiMetrics = await collectAiReadabilityMetrics(sessionManager);
  } finally {
    await sessionManager.closeAll().catch(() => {});
    await browserManager.close().catch(() => {});
    await app.close().catch(() => {});
  }

  const total = results.length;
  const successCount = results.filter((r) => r.success).length;
  const successRate = total === 0 ? 0 : successCount / total;
  const ttdValues = results.map((r) => r.ttdMs).filter((v): v is number => typeof v === 'number');
  const avgTtdMs = ttdValues.length === 0 ? null : Math.round(ttdValues.reduce((a, b) => a + b, 0) / ttdValues.length);
  const noHumanRate = total === 0 ? 0 : results.filter((r) => r.noHumanIntervention).length / total;
  const durationMs = Date.now() - startedAt;

  const report = {
    generatedAt: new Date().toISOString(),
    total,
    successCount,
    successRate,
    avgTtdMs,
    noHumanRate,
    durationMs,
    aiReadability: aiMetrics,
    results,
  };

  const outDir = path.resolve('docs/reports');
  mkdirSync(outDir, { recursive: true });

  const jsonPath = path.join(outDir, 'v1-baseline.json');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');

  const mdLines = [
    '# v1 Baseline Report',
    '',
    `- GeneratedAt: ${report.generatedAt}`,
    `- Total: ${report.total}`,
    `- SuccessCount: ${report.successCount}`,
    `- SuccessRate: ${(report.successRate * 100).toFixed(1)}%`,
    `- AvgTTD(ms): ${report.avgTtdMs ?? 'N/A'}`,
    `- NoHumanRate: ${(report.noHumanRate * 100).toFixed(1)}%`,
    `- Duration(ms): ${report.durationMs}`,
    '',
    '## AI Readability Metrics',
    '',
    `- ToolResponses: ${report.aiReadability?.toolResponses ?? 0}`,
    `- AiFieldCoverageRate: ${(((report.aiReadability?.aiFieldCoverageRate ?? 0) * 100).toFixed(1))}%`,
    `- FollowUpActionAttempts: ${report.aiReadability?.followUpActionAttempts ?? 0}`,
    `- InvalidToolCallRate: ${(((report.aiReadability?.invalidToolCallRate ?? 0) * 100).toFixed(1))}%`,
    `- FollowUpActionSuccessRate: ${(((report.aiReadability?.followUpActionSuccessRate ?? 0) * 100).toFixed(1))}%`,
    '',
    '## Scenario Results',
    '',
    '| Scenario | Success | TTD(ms) | Error |',
    '|---|---:|---:|---|',
    ...report.results.map((r) => `| ${r.id} | ${r.success ? 'Y' : 'N'} | ${r.ttdMs ?? '-'} | ${r.error ?? ''} |`),
    '',
    '## AI Field Coverage',
    '',
    '| Tool | Covered | MissingFields |',
    '|---|---:|---|',
    ...(report.aiReadability?.aiFieldCoverage ?? []).map((item) =>
      `| ${item.tool} | ${item.ok ? 'Y' : 'N'} | ${item.missingFields.join(', ') || '-'} |`,
    ),
    '',
    '## Follow-up Action Attempts',
    '',
    '| SourceTool | ActionTool | Success | InvalidCall | ErrorCode |',
    '|---|---|---:|---:|---|',
    ...(report.aiReadability?.followUpActions ?? []).map((item) =>
      `| ${item.sourceTool} | ${item.tool} | ${item.success ? 'Y' : 'N'} | ${item.isInvalidCall ? 'Y' : 'N'} | ${item.errorCode ?? '-'} |`,
    ),
    '',
  ];

  const mdPath = path.join(outDir, 'v1-baseline.md');
  writeFileSync(mdPath, mdLines.join('\n'), 'utf-8');

  // eslint-disable-next-line no-console
  console.log(`[baseline] report written: ${jsonPath}`);
  // eslint-disable-next-line no-console
  console.log(`[baseline] report written: ${mdPath}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[baseline] failed:', err);
  process.exit(1);
});
