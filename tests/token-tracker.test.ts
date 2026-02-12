import { describe, it, expect } from 'vitest';
import { TokenTracker } from '../src/agent/token-tracker.js';

describe('TokenTracker', () => {
  it('starts with zero tokens', () => {
    const tracker = new TokenTracker();
    expect(tracker.getTotalTokens()).toBe(0);
    expect(tracker.getCallCount()).toBe(0);
  });

  it('records LLM call usage', () => {
    const tracker = new TokenTracker();
    tracker.recordLLMCall({ prompt_tokens: 100, completion_tokens: 50 });
    expect(tracker.getTotalTokens()).toBe(150);
    expect(tracker.getCallCount()).toBe(1);
  });

  it('accumulates across multiple calls', () => {
    const tracker = new TokenTracker();
    tracker.recordLLMCall({ prompt_tokens: 100, completion_tokens: 50 });
    tracker.recordLLMCall({ prompt_tokens: 200, completion_tokens: 80 });
    const usage = tracker.getUsage();
    expect(usage.input).toBe(300);
    expect(usage.output).toBe(130);
    expect(usage.total).toBe(430);
    expect(tracker.getCallCount()).toBe(2);
  });

  it('handles undefined usage gracefully', () => {
    const tracker = new TokenTracker();
    tracker.recordLLMCall(undefined);
    expect(tracker.getTotalTokens()).toBe(0);
    expect(tracker.getCallCount()).toBe(0);
  });

  it('handles partial usage fields', () => {
    const tracker = new TokenTracker();
    tracker.recordLLMCall({ prompt_tokens: 100 });
    expect(tracker.getUsage().input).toBe(100);
    expect(tracker.getUsage().output).toBe(0);
  });
});
