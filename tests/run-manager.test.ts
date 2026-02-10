import { describe, it, expect, afterEach } from 'vitest';
import { RunManager } from '../src/task/run-manager.js';
import { CancelToken } from '../src/task/cancel-token.js';

describe('RunManager', () => {
  let rm: RunManager;

  afterEach(() => {
    rm?.dispose();
  });

  // --- Basic sync submit ---

  it('sync submit returns result inline', async () => {
    rm = new RunManager();
    const executor = async (_runId: string, _token: CancelToken, onProgress: (n: number) => void) => {
      onProgress(1);
      return { summary: { total: 1, succeeded: 1, failed: 0 }, items: ['ok'] };
    };

    const { runId, syncResult } = await rm.submit('test_tpl', 'sess1', false, 1, executor, { mode: 'sync' });
    expect(runId).toBeTruthy();
    expect(syncResult).toBeDefined();
    expect(syncResult.summary.succeeded).toBe(1);

    const run = rm.get(runId);
    expect(run).toBeDefined();
    expect(run!.status).toBe('succeeded');
    expect(run!.metrics.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  // --- Async submit ---

  it('async submit returns runId immediately, run completes later', async () => {
    rm = new RunManager();
    let resolveExec: () => void;
    const execPromise = new Promise<void>((r) => { resolveExec = r; });

    const executor = async (_runId: string, _token: CancelToken, onProgress: (n: number) => void) => {
      await execPromise;
      onProgress(1);
      return { summary: { total: 1, succeeded: 1, failed: 0 } };
    };

    const { runId, syncResult } = await rm.submit('test_tpl', 'sess1', false, 1, executor, { mode: 'async' });
    expect(runId).toBeTruthy();
    expect(syncResult).toBeUndefined();

    // Run should be queued or running
    let run = rm.get(runId);
    expect(['queued', 'running']).toContain(run!.status);

    // Complete the executor
    resolveExec!();
    await new Promise(r => setTimeout(r, 50));

    run = rm.get(runId);
    expect(run!.status).toBe('succeeded');
  });

  // --- Cancel ---

  it('cancel transitions run to canceled', async () => {
    rm = new RunManager();
    let resolveExec: () => void;
    const execPromise = new Promise<void>((r) => { resolveExec = r; });

    const executor = async (_runId: string, token: CancelToken, _onProgress: (n: number) => void) => {
      await execPromise;
      token.throwIfCanceled();
      return { summary: { total: 1, succeeded: 1, failed: 0 } };
    };

    const { runId } = await rm.submit('test_tpl', 'sess1', false, 1, executor, { mode: 'async' });

    // Wait for it to start running
    await new Promise(r => setTimeout(r, 20));

    const canceled = rm.cancel(runId);
    expect(canceled).toBe(true);

    const run = rm.get(runId);
    expect(run!.status).toBe('canceled');
    expect(run!.error?.errorCode).toBe('RUN_CANCELED');

    // Resolve to avoid dangling promise
    resolveExec!();
    await new Promise(r => setTimeout(r, 20));
  });

  it('cancel returns false for terminal run', async () => {
    rm = new RunManager();
    const executor = async () => ({ summary: { total: 1, succeeded: 1, failed: 0 } });
    const { runId } = await rm.submit('test_tpl', 'sess1', false, 1, executor, { mode: 'sync' });

    const canceled = rm.cancel(runId);
    expect(canceled).toBe(false);
  });

  it('cancel returns false for unknown runId', () => {
    rm = new RunManager();
    expect(rm.cancel('nonexistent')).toBe(false);
  });

  // --- List with filters ---

  it('list returns all runs sorted by createdAt desc', async () => {
    rm = new RunManager();
    const executor = async () => ({ summary: { total: 1, succeeded: 1, failed: 0 } });

    await rm.submit('tpl_a', 'sess1', false, 1, executor, { mode: 'sync' });
    // Small delay to ensure different createdAt timestamps
    await new Promise(r => setTimeout(r, 5));
    await rm.submit('tpl_b', 'sess1', false, 1, executor, { mode: 'sync' });

    const runs = rm.list();
    expect(runs).toHaveLength(2);
    // Newest first
    expect(runs[0].templateId).toBe('tpl_b');
    expect(runs[1].templateId).toBe('tpl_a');
  });

  it('list filters by status', async () => {
    rm = new RunManager();
    const successExec = async () => ({ summary: { total: 1, succeeded: 1, failed: 0 } });
    const failExec = async () => ({ summary: { total: 2, succeeded: 0, failed: 2 } });

    await rm.submit('tpl', 'sess1', false, 1, successExec, { mode: 'sync' });
    await rm.submit('tpl', 'sess1', false, 1, failExec, { mode: 'sync' });

    const succeeded = rm.list({ status: 'succeeded' });
    expect(succeeded).toHaveLength(1);

    const failed = rm.list({ status: 'failed' });
    expect(failed).toHaveLength(1);
  });

  it('list filters by templateId', async () => {
    rm = new RunManager();
    const executor = async () => ({ summary: { total: 1, succeeded: 1, failed: 0 } });

    await rm.submit('tpl_a', 'sess1', false, 1, executor, { mode: 'sync' });
    await rm.submit('tpl_b', 'sess1', false, 1, executor, { mode: 'sync' });

    const filtered = rm.list({ templateId: 'tpl_a' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].templateId).toBe('tpl_a');
  });

  it('list supports limit and offset', async () => {
    rm = new RunManager();
    const executor = async () => ({ summary: { total: 1, succeeded: 1, failed: 0 } });

    for (let i = 0; i < 5; i++) {
      await rm.submit('tpl', 'sess1', false, 1, executor, { mode: 'sync' });
    }

    const page1 = rm.list({ limit: 2, offset: 0 });
    expect(page1).toHaveLength(2);

    const page2 = rm.list({ limit: 2, offset: 2 });
    expect(page2).toHaveLength(2);

    const page3 = rm.list({ limit: 2, offset: 4 });
    expect(page3).toHaveLength(1);
  });

  // --- Concurrency control ---

  it('respects maxConcurrentRuns', async () => {
    rm = new RunManager({ maxConcurrentRuns: 2 });
    const running: string[] = [];
    let maxConcurrent = 0;

    const executor = async (runId: string) => {
      running.push(runId);
      maxConcurrent = Math.max(maxConcurrent, running.length);
      await new Promise(r => setTimeout(r, 50));
      running.splice(running.indexOf(runId), 1);
      return { summary: { total: 1, succeeded: 1, failed: 0 } };
    };

    // Submit 4 runs async
    const promises = [];
    for (let i = 0; i < 4; i++) {
      promises.push(rm.submit('tpl', 'sess1', false, 1, executor, { mode: 'async' }));
    }
    await Promise.all(promises);

    // Wait for all to complete
    await new Promise(r => setTimeout(r, 300));

    expect(maxConcurrent).toBeLessThanOrEqual(2);

    const all = rm.list();
    const succeededCount = all.filter(r => r.status === 'succeeded').length;
    expect(succeededCount).toBe(4);
  });

  // --- Timeout ---

  it('times out a slow run', async () => {
    rm = new RunManager();
    const executor = async (_runId: string, _token: CancelToken) => {
      await new Promise(r => setTimeout(r, 5000));
      return { summary: { total: 1, succeeded: 1, failed: 0 } };
    };

    const { runId } = await rm.submit('tpl', 'sess1', false, 1, executor, {
      mode: 'async',
      timeoutMs: 100,
    });

    // Wait for timeout to fire
    await new Promise(r => setTimeout(r, 300));

    const run = rm.get(runId);
    expect(run!.status).toBe('failed');
    expect(run!.error?.errorCode).toBe('RUN_TIMEOUT');
  });

  // --- Progress tracking ---

  it('tracks progress updates', async () => {
    rm = new RunManager();
    const executor = async (_runId: string, _token: CancelToken, onProgress: (n: number) => void) => {
      onProgress(1);
      onProgress(2);
      onProgress(3);
      return { summary: { total: 3, succeeded: 3, failed: 0 } };
    };

    const { runId } = await rm.submit('tpl', 'sess1', false, 3, executor, { mode: 'sync' });
    const run = rm.get(runId);
    expect(run!.progress.totalSteps).toBe(3);
    expect(run!.progress.doneSteps).toBe(3);
  });

  // --- Partial success ---

  it('determines partial_success status', async () => {
    rm = new RunManager();
    const executor = async () => ({ summary: { total: 4, succeeded: 2, failed: 2 } });

    const { runId } = await rm.submit('tpl', 'sess1', false, 4, executor, { mode: 'sync' });
    const run = rm.get(runId);
    expect(run!.status).toBe('partial_success');
  });

  it('treats result.success=false as failed', async () => {
    rm = new RunManager();
    const executor = async () => ({ success: false, error: 'indicator not reached' });

    const { runId } = await rm.submit('tpl', 'sess1', false, 1, executor, { mode: 'sync' });
    expect(rm.get(runId)?.status).toBe('failed');
  });

  // --- Attach artifact ---

  it('attachArtifact adds artifactId to run', async () => {
    rm = new RunManager();
    const executor = async () => ({ summary: { total: 1, succeeded: 1, failed: 0 } });

    const { runId } = await rm.submit('tpl', 'sess1', false, 1, executor, { mode: 'sync' });
    rm.attachArtifact(runId, 'art-1');
    rm.attachArtifact(runId, 'art-2');

    const run = rm.get(runId);
    expect(run!.artifactIds).toEqual(['art-1', 'art-2']);
  });

  // --- Executor error ---

  it('executor error transitions to failed', async () => {
    rm = new RunManager();
    const executor = async () => {
      throw new Error('boom');
    };

    await expect(
      rm.submit('tpl', 'sess1', false, 1, executor, { mode: 'sync' }),
    ).rejects.toThrow('boom');

    const runs = rm.list({ status: 'failed' });
    expect(runs).toHaveLength(1);
    expect(runs[0].error?.message).toBe('boom');
  });


  it('invokes terminal hook and keeps terminal result', async () => {
    rm = new RunManager();
    const seen: string[] = [];
    const executor = async () => ({ summary: { total: 1, succeeded: 1, failed: 0 }, payload: 42 });

    const { runId } = await rm.submit('tpl', 'sess1', true, 1, executor, {
      mode: 'sync',
      onTerminal: async (run) => {
        seen.push(run.status);
      },
    });

    expect(seen).toEqual(['succeeded']);
    expect(rm.get(runId)?.result?.payload).toBe(42);
  });

  it('preserves partial result when canceled run exits later', async () => {
    rm = new RunManager();
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const executor = async (_runId: string, token: CancelToken) => {
      await gate;
      if (token.canceled) {
        return { summary: { total: 2, succeeded: 1, failed: 1 }, items: ['partial'] };
      }
      return { summary: { total: 2, succeeded: 2, failed: 0 }, items: ['full'] };
    };

    const { runId } = await rm.submit('tpl', 'sess1', true, 2, executor, { mode: 'async' });
    await new Promise((r) => setTimeout(r, 20));
    expect(rm.cancel(runId)).toBe(true);

    release!();
    await new Promise((r) => setTimeout(r, 50));

    const run = rm.get(runId);
    expect(run?.status).toBe('canceled');
    expect(run?.result?.summary?.succeeded).toBe(1);
  });

  // --- Dispose ---

  it('dispose clears all state', async () => {
    rm = new RunManager();
    const executor = async () => ({ summary: { total: 1, succeeded: 1, failed: 0 } });
    await rm.submit('tpl', 'sess1', false, 1, executor, { mode: 'sync' });

    rm.dispose();
    expect(rm.list()).toHaveLength(0);
  });
});
