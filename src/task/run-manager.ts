import { randomUUID } from 'node:crypto';
import { CancelToken } from './cancel-token.js';
import { ErrorCode } from './error-codes.js';

// ===== Types =====

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'partial_success' | 'canceled';

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  'succeeded', 'failed', 'partial_success', 'canceled',
]);

export interface RunState {
  runId: string;
  templateId: string;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  sessionId: string;
  ownsSession: boolean;
  progress: { totalSteps: number; doneSteps: number };
  metrics: { elapsedMs: number };
  result?: any;
  error?: { errorCode: string; message: string; details?: any };
  artifactIds: string[];
}

// ===== Semaphore for concurrency control =====

class Semaphore {
  private _count: number;
  private _waiters: Array<() => void> = [];

  constructor(max: number) {
    this._count = max;
  }

  async acquire(): Promise<void> {
    if (this._count > 0) {
      this._count--;
      return;
    }
    return new Promise<void>((resolve) => {
      this._waiters.push(resolve);
    });
  }

  release(): void {
    const next = this._waiters.shift();
    if (next) {
      next();
    } else {
      this._count++;
    }
  }
}

// ===== RunManager =====

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_CONCURRENT = 5;

export interface RunManagerOptions {
  ttlMs?: number;
  maxConcurrentRuns?: number;
}

type TerminalHook = (run: RunState) => void | Promise<void>;

export class RunManager {
  private runs = new Map<string, RunState>();
  private tokens = new Map<string, CancelToken>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private terminalHooks = new Map<string, TerminalHook>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private ttlMs: number;
  private semaphore: Semaphore;

  constructor(opts?: RunManagerOptions) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.semaphore = new Semaphore(opts?.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT);
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /**
   * Submit a run for execution.
   * In sync mode, awaits the executor and returns the result inline.
   * In async mode, fires the executor and returns immediately with runId.
   */
  async submit(
    templateId: string,
    sessionId: string,
    ownsSession: boolean,
    totalSteps: number,
    executor: (
      runId: string,
      token: CancelToken,
      onProgress: (done: number) => void,
    ) => Promise<any>,
    opts: { timeoutMs?: number; mode: 'sync' | 'async'; onTerminal?: TerminalHook },
  ): Promise<{ runId: string; syncResult?: any }> {
    const run = this.createRun(templateId, sessionId, ownsSession, totalSteps);
    const token = new CancelToken();
    this.tokens.set(run.runId, token);
    if (opts.onTerminal) {
      this.terminalHooks.set(run.runId, opts.onTerminal);
    }

    if (opts.mode === 'sync') {
      const result = await this.executeRun(run.runId, executor, token, opts.timeoutMs);
      return { runId: run.runId, syncResult: result };
    }

    // Async: fire-and-forget
    this.executeRun(run.runId, executor, token, opts.timeoutMs).catch(() => {});
    return { runId: run.runId };
  }

  get(runId: string): RunState | undefined {
    return this.runs.get(runId);
  }

  cancel(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    if (TERMINAL_STATUSES.has(run.status)) return false;

    const token = this.tokens.get(runId);
    if (token) token.cancel();

    this.transition(runId, 'canceled');
    run.error = { errorCode: ErrorCode.RUN_CANCELED, message: 'Run canceled by user' };
    return true;
  }

  list(filter?: {
    status?: RunStatus;
    templateId?: string;
    limit?: number;
    offset?: number;
  }): RunState[] {
    const results = this.filterRuns(filter);
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 50;
    return results.slice(offset, offset + limit);
  }

  count(filter?: { status?: RunStatus; templateId?: string }): number {
    return this.filterRuns(filter).length;
  }

  attachArtifact(runId: string, artifactId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.artifactIds.push(artifactId);
    run.updatedAt = Date.now();
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const token of this.tokens.values()) {
      token.cancel();
    }
    this.tokens.clear();
    this.terminalHooks.clear();
    this.runs.clear();
  }

  // --- Internal helpers ---

  private createRun(
    templateId: string,
    sessionId: string,
    ownsSession: boolean,
    totalSteps: number,
  ): RunState {
    const now = Date.now();
    const run: RunState = {
      runId: randomUUID(),
      templateId,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      sessionId,
      ownsSession,
      progress: { totalSteps, doneSteps: 0 },
      metrics: { elapsedMs: 0 },
      artifactIds: [],
    };
    this.runs.set(run.runId, run);
    return run;
  }

  private transition(runId: string, status: RunStatus): void {
    const run = this.runs.get(runId);
    if (!run) return;
    if (TERMINAL_STATUSES.has(run.status)) return;
    run.status = status;
    run.updatedAt = Date.now();
    if (TERMINAL_STATUSES.has(status)) {
      run.metrics.elapsedMs = run.updatedAt - run.createdAt;
      // Cleanup token and timer
      this.tokens.delete(runId);
      const timer = this.timers.get(runId);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(runId);
      }
    }
  }

  private updateProgress(runId: string, doneSteps: number): void {
    const run = this.runs.get(runId);
    if (!run || TERMINAL_STATUSES.has(run.status)) return;
    run.progress.doneSteps = doneSteps;
    run.updatedAt = Date.now();
  }

  private async executeRun(
    runId: string,
    executor: (
      runId: string,
      token: CancelToken,
      onProgress: (done: number) => void,
    ) => Promise<any>,
    token: CancelToken,
    timeoutMs?: number,
  ): Promise<any> {
    // Acquire semaphore slot
    await this.semaphore.acquire();

    try {
      // Check if canceled while waiting for semaphore
      if (token.canceled) {
        this.transition(runId, 'canceled');
        return undefined;
      }

      this.transition(runId, 'running');

      // Setup timeout
      const timeout = Math.min(timeoutMs ?? 300_000, 600_000);
      const timeoutTimer = setTimeout(() => {
        const run = this.runs.get(runId);
        if (run && run.status === 'running') {
          token.cancel();
          run.error = {
            errorCode: ErrorCode.RUN_TIMEOUT,
            message: 'Execution timed out',
          };
          this.transition(runId, 'failed');
        }
      }, timeout);
      this.timers.set(runId, timeoutTimer);

      // Execute
      const result = await executor(
        runId,
        token,
        (done) => this.updateProgress(runId, done),
      );

      // Check if already transitioned (timeout/cancel)
      const run = this.runs.get(runId);
      if (!run) {
        return undefined;
      }
      if (TERMINAL_STATUSES.has(run.status)) {
        // Preserve partial results even if status has already been finalized.
        if (run.result === undefined && result !== undefined) {
          run.result = result;
        }
        return run.result;
      }

      // Determine final status from result
      run.result = result;
      const status = this.determineStatus(result);
      this.transition(runId, status);
      return result;
    } catch (err: any) {
      const run = this.runs.get(runId);
      if (run && TERMINAL_STATUSES.has(run.status)) {
        return run.result;
      }
      if (run && !TERMINAL_STATUSES.has(run.status)) {
        run.error = {
          errorCode: err.errorCode ?? ErrorCode.EXECUTION_ERROR,
          message: err.message || 'Execution failed',
        };
        this.transition(runId, 'failed');
      }
      throw err;
    } finally {
      this.semaphore.release();
      await this.fireTerminalHook(runId);
    }
  }

  private async fireTerminalHook(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || !TERMINAL_STATUSES.has(run.status)) {
      return;
    }
    const hook = this.terminalHooks.get(runId);
    if (!hook) {
      return;
    }
    this.terminalHooks.delete(runId);
    try {
      await hook(run);
    } catch {
      // Ignore terminal hook failures to avoid masking run status.
    }
  }

  private determineStatus(result: any): RunStatus {
    if (result?.summary && typeof result.summary.succeeded === 'number' && typeof result.summary.total === 'number') {
      const { succeeded, total } = result.summary;
      if (succeeded === total) return 'succeeded';
      if (total > 0 && succeeded / total >= 0.5) return 'partial_success';
      return 'failed';
    }

    if (typeof result?.success === 'boolean') {
      return result.success ? 'succeeded' : 'failed';
    }

    return 'succeeded';
  }

  private filterRuns(filter?: { status?: RunStatus; templateId?: string }): RunState[] {
    let results = Array.from(this.runs.values());

    if (filter?.status) {
      results = results.filter((r) => r.status === filter.status);
    }
    if (filter?.templateId) {
      results = results.filter((r) => r.templateId === filter.templateId);
    }

    // Sort by createdAt descending (newest first)
    results.sort((a, b) => b.createdAt - a.createdAt);
    return results;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, run] of this.runs) {
      if (TERMINAL_STATUSES.has(run.status) && now - run.updatedAt > this.ttlMs) {
        this.runs.delete(id);
        this.tokens.delete(id);
        this.terminalHooks.delete(id);
        const timer = this.timers.get(id);
        if (timer) {
          clearTimeout(timer);
          this.timers.delete(id);
        }
      }
    }
  }
}
