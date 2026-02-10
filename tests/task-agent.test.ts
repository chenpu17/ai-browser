import { describe, it, expect, vi } from 'vitest';
import { TaskAgent, type TaskSpec } from '../src/agent/task-agent.js';

function textResult(data: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] } as any;
}

describe('TaskAgent', () => {
  it('plans batch_extract_pages when urls provided', () => {
    const mcpClient = { callTool: vi.fn() } as any;
    const agent = new TaskAgent({ mcpClient });

    const plan = agent.plan({
      goal: '批量抓取页面',
      inputs: { urls: ['https://a.com'] },
    });

    expect(plan).toHaveLength(1);
    expect(plan[0].type).toBe('template');
    expect(plan[0].templateId).toBe('batch_extract_pages');
  });

  it('falls back to agent_goal when no template matches', () => {
    const mcpClient = { callTool: vi.fn() } as any;
    const agent = new TaskAgent({ mcpClient });

    const plan = agent.plan({ goal: '请探索这个页面并总结重点' });

    expect(plan).toHaveLength(1);
    expect(plan[0].type).toBe('agent_goal');
    expect(plan[0].goal).toContain('探索');
  });

  it('executes template flow and verifies output schema', async () => {
    const callTool = vi.fn(async ({ name }: { name: string }) => {
      if (name === 'run_task_template') {
        return textResult({ runId: 'run_1', status: 'queued', mode: 'async', deduplicated: false });
      }
      if (name === 'get_task_run') {
        return textResult({
          runId: 'run_1',
          status: 'succeeded',
          progress: { totalSteps: 1, doneSteps: 1 },
          result: { date: '2026-02-10', orderCount: 10, totalAmount: 999.9 },
          artifactIds: ['art_1'],
        });
      }
      throw new Error(`unexpected tool: ${name}`);
    });

    const agent = new TaskAgent({ mcpClient: { callTool } as any, pollIntervalMs: 1 });

    const taskSpec: TaskSpec = {
      goal: '批量提取订单汇总',
      inputs: { urls: ['https://a.com'] },
      outputSchema: {
        type: 'object',
        required: ['date', 'orderCount', 'totalAmount'],
        properties: {
          date: { type: 'string' },
          orderCount: { type: 'number' },
          totalAmount: { type: 'number' },
        },
      },
    };

    const events: any[] = [];
    agent.on('event', (e) => events.push(e));

    const traceId = agent.resetTraceId();
    const result = await agent.run(taskSpec);

    expect(result.success).toBe(true);
    expect(result.traceId).toBe(traceId);
    expect(result.runId).toBe('run_1');
    expect(result.artifacts).toEqual(['art_1']);
    expect(result.verification.pass).toBe(true);
    expect(events.some((e) => e.type === 'plan_created')).toBe(true);
    expect(events.some((e) => e.type === 'verification_result')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('executes agent_goal through runAgentGoal', async () => {
    const runAgentGoal = vi.fn(async () => ({ success: true, result: { summary: 'done' }, iterations: 1 }));
    const agent = new TaskAgent({
      mcpClient: { callTool: vi.fn() } as any,
      runAgentGoal,
      pollIntervalMs: 1,
    });

    const result = await agent.run({ goal: '未知任务类型，走自由执行' });

    expect(runAgentGoal).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ summary: 'done' });
  });

  it('returns failed result and emits done when template run fails', async () => {
    const callTool = vi.fn(async ({ name }: { name: string }) => {
      if (name === 'run_task_template') {
        return textResult({ runId: 'run_fail' });
      }
      if (name === 'get_task_run') {
        return textResult({
          runId: 'run_fail',
          status: 'failed',
          error: { message: 'template failure' },
        });
      }
      throw new Error(`unexpected tool: ${name}`);
    });

    const agent = new TaskAgent({ mcpClient: { callTool } as any, pollIntervalMs: 1 });
    const events: any[] = [];
    agent.on('event', (e) => events.push(e));

    const result = await agent.run({
      goal: '批量抓取页面',
      inputs: { urls: ['https://a.com'] },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('template failure');
    expect(events.at(-1)?.type).toBe('done');
  });

  it('uses llm classifier fallback when enabled and rules miss', async () => {
    const callTool = vi.fn(async ({ name }: { name: string }) => {
      if (name === 'run_task_template') {
        return textResult({ runId: 'run_llm' });
      }
      if (name === 'get_task_run') {
        return textResult({
          runId: 'run_llm',
          status: 'succeeded',
          result: { ok: true },
          artifactIds: [],
        });
      }
      throw new Error(`unexpected tool: ${name}`);
    });
    const classifyWithLlm = vi.fn(async () => ({
      id: 'llm_1',
      type: 'template' as const,
      templateId: 'batch_extract_pages',
      inputs: { urls: ['https://a.com'] },
    }));

    const agent = new TaskAgent({
      mcpClient: { callTool } as any,
      classifyWithLlm,
      enableLlmFallback: true,
      pollIntervalMs: 1,
    });

    const events: any[] = [];
    agent.on('event', (e) => events.push(e));

    const result = await agent.run({ goal: '请执行这个未知任务类型' });

    expect(result.success).toBe(true);
    expect(classifyWithLlm).toHaveBeenCalledTimes(1);
    const planEvent = events.find((e) => e.type === 'plan_created');
    expect(planEvent?.plannerSource).toBe('llm_fallback');
  });

  it('stops when maxSteps budget is exhausted', async () => {
    const runAgentGoal = vi.fn(async () => ({ success: true, result: { ok: true }, iterations: 1 }));
    const agent = new TaskAgent({
      mcpClient: { callTool: vi.fn() } as any,
      runAgentGoal,
      pollIntervalMs: 1,
    });

    (agent as any).plan = () => [
      { id: 's1', type: 'agent_goal', goal: 'first' },
      { id: 's2', type: 'agent_goal', goal: 'second' },
    ];

    const result = await agent.run({
      goal: 'custom',
      constraints: { maxSteps: 1 },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('maxSteps exceeded');
    expect(runAgentGoal).toHaveBeenCalledTimes(1);
  });

  it('does not count get_task_run polling toward maxToolCalls', async () => {
    let pollCount = 0;
    const callTool = vi.fn(async ({ name }: { name: string }) => {
      if (name === 'run_task_template') {
        return textResult({ runId: 'run_poll' });
      }
      if (name === 'get_task_run') {
        pollCount += 1;
        if (pollCount < 3) {
          return textResult({ runId: 'run_poll', status: 'running', progress: { totalSteps: 1, doneSteps: 0 } });
        }
        return textResult({
          runId: 'run_poll',
          status: 'succeeded',
          result: { ok: true },
          artifactIds: [],
        });
      }
      throw new Error(`unexpected tool: ${name}`);
    });

    const agent = new TaskAgent({ mcpClient: { callTool } as any, pollIntervalMs: 1 });

    const result = await agent.run({
      goal: '批量抓取页面',
      inputs: { urls: ['https://a.com'] },
      budget: { maxToolCalls: 1, maxRetries: 0 },
    });

    expect(result.success).toBe(true);
    expect(pollCount).toBeGreaterThan(1);
  });


  it('fails when effective template tool calls exceed maxToolCalls', async () => {
    let runCount = 0;
    const callTool = vi.fn(async ({ name }: { name: string }) => {
      if (name === 'run_task_template') {
        runCount += 1;
        return textResult({ runId: `run_limit_${runCount}` });
      }
      if (name === 'get_task_run') {
        return textResult({
          runId: `run_limit_${runCount}`,
          status: 'succeeded',
          result: {},
          artifactIds: [],
        });
      }
      throw new Error(`unexpected tool: ${name}`);
    });

    const agent = new TaskAgent({ mcpClient: { callTool } as any, pollIntervalMs: 1 });
    (agent as any).repair = () => [
      { id: 'repair_tpl', type: 'template', templateId: 'batch_extract_pages', inputs: { urls: ['https://a.com'] } },
    ];

    const result = await agent.run({
      goal: '批量抓取页面',
      inputs: { urls: ['https://a.com'] },
      budget: { maxRetries: 1, maxToolCalls: 1 },
      outputSchema: {
        type: 'object',
        required: ['requiredField'],
        properties: {
          requiredField: { type: 'string' },
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('maxToolCalls exceeded');
  });

  it('triggers repair flow and succeeds on retry', async () => {
    const runAgentGoal = vi
      .fn()
      .mockResolvedValueOnce({ success: true, result: {}, iterations: 1 })
      .mockResolvedValueOnce({ success: true, result: { amount: 100 }, iterations: 1 });

    const agent = new TaskAgent({
      mcpClient: { callTool: vi.fn() } as any,
      runAgentGoal,
      pollIntervalMs: 1,
    });

    const events: any[] = [];
    agent.on('event', (e) => events.push(e));

    const result = await agent.run({
      goal: 'free-form task',
      budget: { maxRetries: 1 },
      outputSchema: {
        type: 'object',
        required: ['amount'],
        properties: {
          amount: { type: 'number' },
        },
      },
    });

    expect(result.success).toBe(true);
    expect(runAgentGoal).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === 'repair_attempted')).toBe(true);
  });

});
