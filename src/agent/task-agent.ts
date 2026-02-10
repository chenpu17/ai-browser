import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

const TERMINAL_STATUSES = new Set([
  'succeeded',
  'failed',
  'partial_success',
  'canceled',
]);

export interface TaskSpec {
  taskId?: string;
  goal: string;
  inputs?: Record<string, unknown>;
  constraints?: {
    maxDurationMs?: number;
    maxSteps?: number;
    allowHumanInput?: boolean;
  };
  budget?: {
    maxToolCalls?: number;
    maxRetries?: number;
  };
  outputSchema?: Record<string, unknown>;
}

export type PlanStep = {
  id: string;
  type: 'template' | 'agent_goal';
  templateId?: string;
  inputs?: Record<string, unknown>;
  goal?: string;
  fallbackStepIds?: string[];
  dependsOn?: string[];
};

export type PlannerRule = {
  id: string;
  match: (taskSpec: TaskSpec) => boolean;
  buildStep: (taskSpec: TaskSpec) => PlanStep;
};

export type PlannerSource = 'rules' | 'llm_fallback' | 'fallback_agent_goal';

export type VerifyResult = {
  pass: boolean;
  score: number;
  missingFields: string[];
  typeMismatches: string[];
  reason?: string;
};

export type TaskAgentResult = {
  success: boolean;
  runId?: string;
  summary: string;
  result?: unknown;
  artifacts: string[];
  verification: VerifyResult;
  iterations: number;
  traceId: string;
  error?: string;
};

type GoalRunner = (goal: string) => Promise<{ success: boolean; result?: unknown; error?: string; iterations?: number }>;
type PlannerClassifier = (taskSpec: TaskSpec) => Promise<PlanStep | null>;

export class TaskAgent extends EventEmitter {
  private mcpClient: Client;
  private pollIntervalMs: number;
  private runAgentGoal?: GoalRunner;
  private traceId: string;
  private plannerRules: PlannerRule[];
  private enableLlmFallback: boolean;
  private classifyWithLlm?: PlannerClassifier;

  constructor(options: {
    mcpClient: Client;
    pollIntervalMs?: number;
    runAgentGoal?: GoalRunner;
    plannerRules?: PlannerRule[];
    enableLlmFallback?: boolean;
    classifyWithLlm?: PlannerClassifier;
  }) {
    super();
    this.mcpClient = options.mcpClient;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.runAgentGoal = options.runAgentGoal;
    this.traceId = createTraceId();
    this.plannerRules = options.plannerRules ?? defaultPlannerRules();
    this.enableLlmFallback = options.enableLlmFallback ?? false;
    this.classifyWithLlm = options.classifyWithLlm;
  }

  resetTraceId(): string {
    this.traceId = createTraceId();
    return this.traceId;
  }

  getTraceId(): string {
    return this.traceId;
  }

  async planResolved(taskSpec: TaskSpec): Promise<{ plan: PlanStep[]; source: PlannerSource }> {
    return this.planWithFallback(taskSpec);
  }

  plan(taskSpec: TaskSpec): PlanStep[] {
    for (const rule of this.plannerRules) {
      if (!rule.match(taskSpec)) continue;
      return [rule.buildStep(taskSpec)];
    }

    return [{
      id: 'step_1',
      type: 'agent_goal',
      goal: taskSpec.goal,
    }];
  }

  repair(verify: VerifyResult, _lastRunContext: unknown): PlanStep[] {
    if (verify.pass) return [];
    if (verify.missingFields.length === 0 && verify.typeMismatches.length === 0) {
      return [];
    }

    return [{
      id: 'repair_1',
      type: 'agent_goal',
      goal: `Please fill missing fields and fix type mismatches: missing=${verify.missingFields.join(',')}; type=${verify.typeMismatches.join(',')}`,
    }];
  }

  async run(taskSpec: TaskSpec): Promise<TaskAgentResult> {
    const planResult = await this.planResolved(taskSpec);
    this.emitTaskEvent({ type: 'plan_created', plan: planResult.plan, plannerSource: planResult.source });

    const maxRetries = Math.max(0, taskSpec.budget?.maxRetries ?? 0);
    const maxSteps = Math.max(1, taskSpec.constraints?.maxSteps ?? Number.MAX_SAFE_INTEGER);
    const usage = {
      toolCalls: 0,
      maxToolCalls: Math.max(1, taskSpec.budget?.maxToolCalls ?? Number.MAX_SAFE_INTEGER),
    };

    let retries = 0;
    let currentPlan = planResult.plan;
    let lastResult: unknown = null;
    let lastArtifacts: string[] = [];
    let lastRunId: string | undefined;
    let iterations = 0;

    const finalize = (result: TaskAgentResult): TaskAgentResult => {
      this.emitTaskEvent({
        type: 'done',
        success: result.success,
        runId: result.runId,
        summary: result.summary,
        error: result.error,
        iterations: result.iterations,
      });
      return result;
    };

    try {
      while (true) {
        for (const step of currentPlan) {
          if (iterations >= maxSteps) {
            const failVerify: VerifyResult = {
              pass: false,
              score: 0,
              missingFields: [],
              typeMismatches: [],
              reason: `maxSteps exceeded: ${maxSteps}`,
            };
            return finalize({
              success: false,
              runId: lastRunId,
              summary: 'Task stopped by maxSteps budget',
              result: lastResult,
              artifacts: lastArtifacts,
              verification: failVerify,
              iterations,
              traceId: this.traceId,
              error: failVerify.reason,
            });
          }

          iterations += 1;
          if (step.type === 'template') {
            const { runId, result, artifactIds } = await this.executeTemplateStep(step, taskSpec, usage);
            lastRunId = runId;
            lastResult = result;
            lastArtifacts = artifactIds;
            continue;
          }

          const goalResult = await this.executeGoalStep(step);
          if (!goalResult.success) {
            const failVerify: VerifyResult = {
              pass: false,
              score: 0,
              missingFields: [],
              typeMismatches: [],
              reason: goalResult.error || 'agent_goal execution failed',
            };
            return finalize({
              success: false,
              summary: 'Task failed in agent_goal execution',
              result: goalResult.result,
              artifacts: [],
              verification: failVerify,
              iterations,
              traceId: this.traceId,
              error: failVerify.reason,
            });
          }

          lastResult = goalResult.result;
          lastArtifacts = [];
        }

        const verification = verifyAgainstSchema(lastResult, taskSpec.outputSchema as any);
        this.emitTaskEvent({ type: 'verification_result', verification });

        if (verification.pass || retries >= maxRetries) {
          return finalize({
            success: verification.pass,
            runId: lastRunId,
            summary: verification.pass ? 'Task completed and verified' : 'Task completed but verification failed',
            result: lastResult,
            artifacts: lastArtifacts,
            verification,
            iterations,
            traceId: this.traceId,
            error: verification.pass ? undefined : verification.reason,
          });
        }

        const patchPlan = this.repair(verification, { result: lastResult, runId: lastRunId });
        if (patchPlan.length === 0) {
          return finalize({
            success: false,
            runId: lastRunId,
            summary: 'Verification failed and no repair plan generated',
            result: lastResult,
            artifacts: lastArtifacts,
            verification,
            iterations,
            traceId: this.traceId,
            error: verification.reason,
          });
        }

        this.emitTaskEvent({ type: 'repair_attempted', retry: retries + 1, patchPlan, verification });
        currentPlan = patchPlan;
        retries += 1;
      }
    } catch (err: any) {
      const failVerify: VerifyResult = {
        pass: false,
        score: 0,
        missingFields: [],
        typeMismatches: [],
        reason: err?.message || 'task execution failed',
      };
      return finalize({
        success: false,
        runId: lastRunId,
        summary: 'Task execution failed',
        result: lastResult,
        artifacts: lastArtifacts,
        verification: failVerify,
        iterations,
        traceId: this.traceId,
        error: failVerify.reason,
      });
    }
  }

  private async planWithFallback(taskSpec: TaskSpec): Promise<{ plan: PlanStep[]; source: PlannerSource }> {
    const rulePlan = this.plan(taskSpec);
    if (rulePlan[0]?.type === 'template') {
      return { plan: rulePlan, source: 'rules' };
    }

    if (!this.enableLlmFallback || !this.classifyWithLlm) {
      return { plan: rulePlan, source: 'fallback_agent_goal' };
    }

    try {
      const llmStep = await this.classifyWithLlm(taskSpec);
      const normalized = normalizeClassifierStep(llmStep, taskSpec);
      if (!normalized) {
        return { plan: rulePlan, source: 'fallback_agent_goal' };
      }
      return { plan: [normalized], source: 'llm_fallback' };
    } catch {
      return { plan: rulePlan, source: 'fallback_agent_goal' };
    }
  }

  private emitTaskEvent(payload: Record<string, unknown>): void {
    this.emit('event', {
      traceId: this.traceId,
      ts: new Date().toISOString(),
      ...payload,
    });
  }

  private async executeTemplateStep(
    step: PlanStep,
    taskSpec: TaskSpec,
    usage: { toolCalls: number; maxToolCalls: number },
  ): Promise<{ runId: string; result: unknown; artifactIds: string[] }> {
    if (!step.templateId) {
      throw new Error('Template step missing templateId');
    }

    const timeoutMs = taskSpec.constraints?.maxDurationMs;
    const runOptions: Record<string, unknown> = { mode: 'async' };
    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      runOptions.timeoutMs = timeoutMs;
    }
    if (taskSpec.outputSchema) {
      runOptions.outputSchema = taskSpec.outputSchema;
    }

    usage.toolCalls += 1;
    if (usage.toolCalls > usage.maxToolCalls) {
      throw new Error(`maxToolCalls exceeded: ${usage.maxToolCalls}`);
    }

    const runResp = await this.mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: step.templateId,
        inputs: step.inputs ?? {},
        options: runOptions,
      },
    });

    const runData = parseTextJson(runResp, 'run_task_template');
    const runId = runData?.runId as string | undefined;
    if (!runId) {
      throw new Error('run_task_template did not return runId');
    }

    const startedAt = Date.now();
    const maxDurationMs = taskSpec.constraints?.maxDurationMs ?? 300_000;

    while (true) {
      const pollResp = await this.mcpClient.callTool({
        name: 'get_task_run',
        arguments: { runId },
      });

      const run = parseTextJson(pollResp, `get_task_run(${runId})`);
      this.emitTaskEvent({ type: 'task_progress', runId, status: run?.status, progress: run?.progress });

      if (TERMINAL_STATUSES.has(run?.status)) {
        if (run.status === 'failed' || run.status === 'canceled') {
          throw new Error(run?.error?.message || `run ${runId} failed with status ${run.status}`);
        }
        return {
          runId,
          result: run?.result,
          artifactIds: Array.isArray(run?.artifactIds) ? run.artifactIds : [],
        };
      }

      if (Date.now() - startedAt > maxDurationMs) {
        throw new Error(`task step timeout after ${maxDurationMs}ms`);
      }

      await sleep(this.pollIntervalMs);
    }
  }

  private async executeGoalStep(
    step: PlanStep,
  ): Promise<{ success: boolean; result?: unknown; error?: string; iterations?: number }> {
    if (!step.goal) {
      return { success: false, error: 'agent_goal step missing goal' };
    }
    if (!this.runAgentGoal) {
      return { success: false, error: 'runAgentGoal is not configured' };
    }

    try {
      return await this.runAgentGoal(step.goal);
    } catch (err: any) {
      return {
        success: false,
        error: err?.message || 'runAgentGoal execution failed',
      };
    }
  }
}

function normalizeClassifierStep(step: PlanStep | null, taskSpec: TaskSpec): PlanStep | null {
  if (!step) return null;

  if (step.type === 'template') {
    if (!step.templateId) return null;
    return {
      id: step.id || 'step_1',
      type: 'template',
      templateId: step.templateId,
      inputs: step.inputs ?? taskSpec.inputs,
      fallbackStepIds: step.fallbackStepIds,
      dependsOn: step.dependsOn,
    };
  }

  if (step.type === 'agent_goal') {
    return {
      id: step.id || 'step_1',
      type: 'agent_goal',
      goal: step.goal || taskSpec.goal,
      fallbackStepIds: step.fallbackStepIds,
      dependsOn: step.dependsOn,
    };
  }

  return null;
}

function defaultPlannerRules(): PlannerRule[] {
  return [
    {
      id: 'compare_by_urls_or_goal',
      match(taskSpec: TaskSpec): boolean {
        const goal = taskSpec.goal.toLowerCase();
        const urls = taskSpec.inputs?.urls;
        return (
          Array.isArray(urls) && urls.length >= 2 && (
            goal.includes('对比') ||
            goal.includes('比较') ||
            goal.includes('compare') ||
            goal.includes('diff')
          )
        );
      },
      buildStep(taskSpec: TaskSpec): PlanStep {
        return {
          id: 'step_1',
          type: 'template',
          templateId: 'multi_tab_compare',
          inputs: taskSpec.inputs,
        };
      },
    },
    {
      id: 'batch_extract_by_urls',
      match(taskSpec: TaskSpec): boolean {
        const urls = taskSpec.inputs?.urls;
        return Array.isArray(urls) && urls.length > 0;
      },
      buildStep(taskSpec: TaskSpec): PlanStep {
        return {
          id: 'step_1',
          type: 'template',
          templateId: 'batch_extract_pages',
          inputs: taskSpec.inputs,
        };
      },
    },
    {
      id: 'login_keep_session_by_goal',
      match(taskSpec: TaskSpec): boolean {
        const goal = taskSpec.goal.toLowerCase();
        return goal.includes('login') || goal.includes('登录');
      },
      buildStep(taskSpec: TaskSpec): PlanStep {
        return {
          id: 'step_1',
          type: 'template',
          templateId: 'login_keep_session',
          inputs: taskSpec.inputs,
        };
      },
    },
  ];
}

function parseTextJson(resp: any, context = 'tool response'): any {
  const text = resp?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err: any) {
    throw new Error(`Invalid JSON from ${context}: ${err?.message || 'parse failed'}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTraceId(): string {
  return `trace_${randomUUID()}`;
}

function verifyAgainstSchema(data: unknown, schema?: {
  type?: string;
  required?: string[];
  properties?: Record<string, { type?: string }>;
}): VerifyResult {
  if (!schema) {
    return {
      pass: true,
      score: 1,
      missingFields: [],
      typeMismatches: [],
    };
  }

  const missingFields: string[] = [];
  const typeMismatches: string[] = [];

  if (schema.type === 'object') {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return {
        pass: false,
        score: 0,
        missingFields: schema.required ?? [],
        typeMismatches: ['root'],
        reason: 'result is not an object',
      };
    }

    const obj = data as Record<string, unknown>;
    for (const field of schema.required ?? []) {
      if (obj[field] === undefined || obj[field] === null) {
        missingFields.push(field);
      }
    }

    for (const [key, fieldSchema] of Object.entries(schema.properties ?? {})) {
      if (obj[key] === undefined || obj[key] === null || !fieldSchema.type) continue;
      if (!matchType(obj[key], fieldSchema.type)) {
        typeMismatches.push(key);
      }
    }
  }

  const pass = missingFields.length === 0 && typeMismatches.length === 0;
  const total = (schema.required?.length ?? 0) + Object.keys(schema.properties ?? {}).length || 1;
  const failed = missingFields.length + typeMismatches.length;
  return {
    pass,
    score: Math.max(0, 1 - failed / total),
    missingFields,
    typeMismatches,
    reason: pass ? undefined : 'schema verification failed',
  };
}

function matchType(value: unknown, expected: string): boolean {
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expected === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (expected === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
  return typeof value === expected;
}
