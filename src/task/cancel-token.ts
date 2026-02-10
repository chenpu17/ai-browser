import { ErrorCode } from './error-codes.js';

/**
 * Cooperative cancellation primitive.
 * Passed to template executors; checked between steps.
 */
export class CancelToken {
  private _canceled = false;
  private _listeners: Array<() => void> = [];

  get canceled(): boolean {
    return this._canceled;
  }

  cancel(): void {
    if (this._canceled) return;
    this._canceled = true;
    for (const fn of this._listeners) {
      try { fn(); } catch {}
    }
    this._listeners.length = 0;
  }

  onCancel(fn: () => void): void {
    if (this._canceled) {
      try { fn(); } catch {}
      return;
    }
    this._listeners.push(fn);
  }

  throwIfCanceled(): void {
    if (this._canceled) {
      const err = new Error('Run canceled');
      (err as any).errorCode = ErrorCode.RUN_CANCELED;
      throw err;
    }
  }
}
