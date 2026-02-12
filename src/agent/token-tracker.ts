/**
 * Tracks token usage across LLM API calls.
 */

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

export class TokenTracker {
  private inputTokens = 0;
  private outputTokens = 0;
  private callCount = 0;

  recordLLMCall(usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }): void {
    if (!usage) return;
    this.callCount++;
    this.inputTokens += usage.prompt_tokens ?? 0;
    this.outputTokens += usage.completion_tokens ?? 0;
  }

  getTotalTokens(): number {
    return this.inputTokens + this.outputTokens;
  }

  getUsage(): TokenUsage {
    return {
      input: this.inputTokens,
      output: this.outputTokens,
      total: this.inputTokens + this.outputTokens,
    };
  }

  getCallCount(): number {
    return this.callCount;
  }
}
