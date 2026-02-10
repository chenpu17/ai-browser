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
  error?: string;
};

type GoalRunner = (goal: string) => Promise<{ success: boolean; result?: unknown; error?: string; iterations?: number }>;

export class TaskAgent extends EventEmitter {
  private mcpClient: Client;
  private pollIntervalMs: number;
  private runAgentGoal?: GoalRunner;

  constructor(options: {
    mcpClient: Client;
    pollIntervalMs?: number;
    runAgentGoal?: GoalRunner;
  }) {
    super();
    this.mcpClient = options.mcpClient;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.runAgentGoal = options.runAgentGoal;
  }

  plan(taskSpec: TaskSpec): PlanStep[] {
    const goal = taskSpec.goal.toLowerCase();
    const urls = taskSpec.inputs?.urls;

    if (Array.isArray(urls) && urls.length > 0) {
      if (goal.includes('对比') || goal.includes('compare') || goal.includes('diff') || urls.length >= 2) {
        return [{
          id: 'step_1',
          type: 'template',
          templateId: 'multi_tab_compare',
          inputs: taskSpec.inputs,
        }];
      }
      return [{
        id: 'step_1',
        type: 'template',
        templateId: 'batch_extract_pages',
        inputs: taskSpec.inputs,
      }];
    }

    if (goal.includes('login') || goal.includes('登录')) {
      return [{
        id: 'step_1',
        type: 'template',
        templateId: 'login_keep_session',
        inputs: taskSpec.inputs,
      }];
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
      goal: `请补全缺失字段并修复类型错误：missing=${verify.missingFields.join(',')}; type=${verify.typeMismatches.join(',')}`,
    }];
  }

  async run(taskSpec: TaskSpec): Promise<TaskAgentResult> {
    const plan = this.plan(taskSpec);
    this.emit('event', { type: 'plan_created', plan });

    const maxRetries = Math.max(0, taskSpec.budget?.maxRetries ?? 0);
    let retries = 0;

    let currentPlan = plan;
    let lastResult: unknown = null;
    let lastArtifacts: string[] = [];
    let lastRunId: string | undefined;
    let iterations = 0;

    while (true) {
      for (const step of currentPlan) {
        iterations += 1;
        if (step.type === 'template') {
          const { runId, result, artifactIds } = await this.executeTemplateStep(step, taskSpec);
          lastRunId = runId;
          lastResult = result;
          lastArtifacts = artifactIds;
        } else {
          const goalResult = await this.executeGoalStep(step);
          if (!goalResult.success) {
            const failVerify: VerifyResult = {
              pass: false,
              score: 0,
              missingFields: [],
              typeMismatches: [],
              reason: goalResult.error || 'agent_goal execution failed',
            };
            return {
              success: false,
              summary: 'Task failed in agent_goal execution',
              result: goalResult.result,
              artifacts: [],
              verification: failVerify,
              iterations,
              error: failVerify.reason,
            };
          }
          lastResult = goalResult.result;
          lastArtifacts = [];
        }
      }

      const verification = verifyAgainstSchema(lastResult, taskSpec.outputSchema as any);
      this.emit('event', { type: 'verification_result', verification });

      if (verification.pass || retries >= maxRetries) {
        return {
          success: verification.pass,
          runId: lastRunId,
          summary: verification.pass ? 'Task completed and verified' : 'Task completed but verification failed',
          result: lastResult,
          artifacts: lastArtifacts,
          verification,
          iterations,
          error: verification.pass ? undefined : verification.reason,
        };
      }

      const patchPlan = this.repair(verification, { result: lastResult, runId: lastRunId });
      if (patchPlan.length === 0) {
        return {
          success: false,
          runId: lastRunId,
          summary: 'Verification failed and no repair plan generated',
          result: lastResult,
          artifacts: lastArtifacts,
          verification,
          iterations,
          error: verification.reason,
        };
      }

      this.emit('event', { type: 'repair_attempted', retry: retries + 1, patchPlan, verification });
      currentPlan = patchPlan;
      retries += 1;
    }
  }

  private async executeTemplateStep(step: PlanStep, taskSpec: TaskSpec): Promise<{ runId: string; result: unknown; artifactIds: string[] }> {
    if (!step.templateId) {
      throw new Error('Template step missing templateId');
    }

    const timeoutMs = taskSpec.constraints?.maxDurationMs;
    const runResp = await this.mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: step.templateId,
        inputs: step.inputs ?? {},
        options: {
          mode: 'async',
          timeoutMs,
          outputSchema: taskSpec.outputSchema,
        },
      },
    });

    const runData = parseTextJson(runResp);
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
      const run = parseTextJson(pollResp);
      this.emit('event', { type: 'task_progress', runId, status: run?.status, progress: run?.progress });

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

  private async executeGoalStep(step: PlanStep): Promise<{ success: boolean; result?: unknown; error?: string; iterations?: number }> {
    if (!step.goal) {
      return { success: false, error: 'agent_goal step missing goal' };
    }
    if (!this.runAgentGoal) {
      return { success: false, error: 'runAgentGoal is not configured' };
    }
    return this.runAgentGoal(step.goal);
  }
}

function parseTextJson(resp: any): any {
  const text = resp?.content?.[0]?.text;
  if (!text) return null;
  return JSON.parse(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
