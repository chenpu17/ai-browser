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

    const result = await agent.run(taskSpec);

    expect(result.success).toBe(true);
    expect(result.runId).toBe('run_1');
    expect(result.artifacts).toEqual(['art_1']);
    expect(result.verification.pass).toBe(true);
    expect(events.some((e) => e.type === 'plan_created')).toBe(true);
    expect(events.some((e) => e.type === 'verification_result')).toBe(true);
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
});
