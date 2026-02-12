import { describe, it, expect } from 'vitest';
import { ConversationManager } from '../src/agent/conversation-manager.js';

describe('ConversationManager', () => {
  it('initializes with system prompt + initial messages + user task', () => {
    const cm = new ConversationManager();
    cm.init('You are a helper', [], 'Do something');
    const msgs = cm.getMessages();
    expect(msgs.length).toBe(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
  });

  it('preserves initial messages', () => {
    const cm = new ConversationManager();
    cm.init('system', [{ role: 'user', content: 'prev' }], 'task');
    expect(cm.getMessages().length).toBe(3);
  });

  it('push adds messages', () => {
    const cm = new ConversationManager();
    cm.init('sys', [], 'task');
    cm.push({ role: 'assistant', content: 'thinking' });
    expect(cm.length).toBe(3);
  });

  it('compresses when exceeding threshold', () => {
    const cm = new ConversationManager({
      compressThreshold: 10,
      keepRecent: 5,
    });
    cm.init('system prompt', [], 'user task');
    // Add enough messages to trigger compression
    for (let i = 0; i < 12; i++) {
      cm.push({ role: 'assistant', content: `response ${i}` });
    }
    const msgs = cm.getMessages();
    // Should have: system + summary + recent messages
    expect(msgs.length).toBeLessThanOrEqual(10);
    expect(msgs[0].role).toBe('system');
    // Second message should be the compressed summary
    const summaryMsg = msgs[1];
    expect(summaryMsg.role).toBe('user');
    if (typeof summaryMsg.content === 'string') {
      expect(summaryMsg.content).toContain('对话历史摘要');
    }
  });

  it('preserves system prompt after compression', () => {
    const cm = new ConversationManager({
      compressThreshold: 8,
      keepRecent: 4,
    });
    cm.init('IMPORTANT SYSTEM PROMPT', [], 'task');
    for (let i = 0; i < 10; i++) {
      cm.push({ role: 'assistant', content: `msg ${i}` });
    }
    const msgs = cm.getMessages();
    expect(msgs[0].content).toBe('IMPORTANT SYSTEM PROMPT');
  });

  it('estimates tokens roughly', () => {
    const cm = new ConversationManager();
    cm.init('a'.repeat(400), [], 'b'.repeat(400));
    // ~800 chars / 4 = ~200 tokens
    expect(cm.estimateTokens()).toBeGreaterThanOrEqual(200);
  });

  it('compresses tool call groups into summaries', () => {
    const cm = new ConversationManager({
      compressThreshold: 8,
      keepRecent: 3,
    });
    cm.init('sys', [], 'task');
    // Simulate assistant with tool_calls + tool results
    cm.push({
      role: 'assistant',
      content: 'Let me click',
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'click', arguments: '{}' } }],
    } as any);
    cm.push({ role: 'tool', tool_call_id: 'tc1', content: 'success' } as any);
    cm.push({ role: 'assistant', content: 'Now typing' });
    cm.push({ role: 'assistant', content: 'More thinking' });
    cm.push({ role: 'assistant', content: 'Even more' });
    cm.push({ role: 'assistant', content: 'Final' });
    cm.push({ role: 'assistant', content: 'Done' });

    const msgs = cm.getMessages();
    // Should be compressed
    expect(msgs.length).toBeLessThanOrEqual(8);
  });
});
