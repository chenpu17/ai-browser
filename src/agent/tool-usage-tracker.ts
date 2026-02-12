export interface ToolCallRecord {
  toolName: string;
  args: Record<string, any>;
  success: boolean;
  timestamp: number;
  errorCode?: string;
}

export interface LoopDetection {
  type: 'exact_repeat' | 'oscillation' | 'futile_retry' | 'progress_stall';
  message: string;
  windowSize: number;
}

export class ToolUsageTracker {
  private history: ToolCallRecord[] = [];

  record(call: ToolCallRecord): void {
    this.history.push(call);
  }

  getHistory(): readonly ToolCallRecord[] {
    return this.history;
  }

  getCallCount(toolName?: string): number {
    if (!toolName) return this.history.length;
    return this.history.filter(c => c.toolName === toolName).length;
  }

  getErrorRate(toolName?: string): number {
    const calls = toolName
      ? this.history.filter(c => c.toolName === toolName)
      : this.history;
    if (calls.length === 0) return 0;
    return calls.filter(c => !c.success).length / calls.length;
  }

  /**
   * Detect exact repeated calls: same tool + same args N times in a row.
   */
  detectLoop(windowSize = 3): LoopDetection | null {
    if (this.history.length < windowSize) return null;
    const recent = this.history.slice(-windowSize);
    const sig = this.callSignature(recent[0]);
    const allSame = recent.every(c => this.callSignature(c) === sig);
    if (!allSame) return null;
    return {
      type: 'exact_repeat',
      message: `同一工具 ${recent[0].toolName} 连续调用 ${windowSize} 次且参数相同，不会产生新结果。请换一种方式操作，或用 done 报告当前信息。`,
      windowSize,
    };
  }

  /**
   * Detect A->B->A->B oscillation pattern.
   */
  detectOscillation(windowSize = 6): LoopDetection | null {
    if (this.history.length < windowSize) return null;
    const recent = this.history.slice(-windowSize);
    // Check for A-B-A-B pattern (period=2)
    const sigA = this.callSignature(recent[0]);
    const sigB = this.callSignature(recent[1]);
    if (sigA === sigB) return null;
    let isOscillating = true;
    for (let i = 0; i < windowSize; i++) {
      const expected = i % 2 === 0 ? sigA : sigB;
      if (this.callSignature(recent[i]) !== expected) {
        isOscillating = false;
        break;
      }
    }
    if (!isOscillating) return null;
    return {
      type: 'oscillation',
      message: `检测到交替循环：${recent[0].toolName} 和 ${recent[1].toolName} 反复交替调用。请尝试不同的策略，或用 done 报告当前信息。`,
      windowSize,
    };
  }

  /**
   * Detect same tool + same args failing repeatedly.
   */
  detectFutileRetry(threshold = 2): LoopDetection | null {
    if (this.history.length < threshold) return null;
    const recent = this.history.slice(-threshold);
    const allFailed = recent.every(c => !c.success);
    if (!allFailed) return null;
    const sig = this.callSignature(recent[0]);
    const allSame = recent.every(c => this.callSignature(c) === sig);
    if (!allSame) return null;
    return {
      type: 'futile_retry',
      message: `${recent[0].toolName} 已连续失败 ${threshold} 次且参数相同。请尝试：1) 调用 get_page_info 刷新元素列表 2) 换一种方式操作 3) 用 done 报告当前信息。`,
      windowSize: threshold,
    };
  }

  /**
   * Detect many calls without URL change (progress stall).
   */
  detectProgressStall(callThreshold = 5): LoopDetection | null {
    if (this.history.length < callThreshold) return null;
    const recent = this.history.slice(-callThreshold);
    // Only flag if no navigation-related tools were called
    const navTools = new Set(['navigate', 'click', 'go_back']);
    const hasNav = recent.some(c => navTools.has(c.toolName));
    if (hasNav) return null;
    // All observation tools without action
    const obsTools = new Set(['get_page_info', 'get_page_content', 'find_element', 'screenshot']);
    const allObs = recent.every(c => obsTools.has(c.toolName));
    if (!allObs) return null;
    return {
      type: 'progress_stall',
      message: `已连续 ${callThreshold} 次调用观察类工具但未执行任何操作。请根据已获取的信息执行操作，或用 done 报告结果。`,
      windowSize: callThreshold,
    };
  }

  /**
   * Run all detectors and return the first match.
   */
  detectAny(): LoopDetection | null {
    return (
      this.detectFutileRetry() ||
      this.detectLoop() ||
      this.detectOscillation() ||
      this.detectProgressStall() ||
      null
    );
  }

  /**
   * Summarize tool usage for conversation compression.
   */
  summarize(): string {
    if (this.history.length === 0) return '无工具调用记录';
    const toolCounts = new Map<string, { total: number; errors: number }>();
    for (const call of this.history) {
      const entry = toolCounts.get(call.toolName) || { total: 0, errors: 0 };
      entry.total++;
      if (!call.success) entry.errors++;
      toolCounts.set(call.toolName, entry);
    }
    const parts: string[] = [];
    for (const [name, counts] of toolCounts) {
      const errPart = counts.errors > 0 ? ` (${counts.errors} 失败)` : '';
      parts.push(`${name}×${counts.total}${errPart}`);
    }
    return `共 ${this.history.length} 次工具调用: ${parts.join(', ')}`;
  }

  private callSignature(call: ToolCallRecord): string {
    return `${call.toolName}:${JSON.stringify(call.args)}`;
  }
}
