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

  it('keeps more context for content-heavy tool results during compression', () => {
    const cm = new ConversationManager({
      compressThreshold: 8,
      keepRecent: 3,
    });
    const longContent = Array.from({ length: 180 }, (_, index) => String(index % 10)).join('');
    cm.init('sys', [], 'task');
    cm.push({
      role: 'assistant',
      content: 'Extracting content',
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'get_page_content', arguments: '{}' } }],
    } as any);
    cm.push({ role: 'tool', tool_call_id: 'tc1', content: longContent } as any);
    cm.push({ role: 'assistant', content: 'step 1' });
    cm.push({ role: 'assistant', content: 'step 2' });
    cm.push({ role: 'assistant', content: 'step 3' });
    cm.push({ role: 'assistant', content: 'step 4' });
    cm.push({ role: 'assistant', content: 'step 5' });

    const msgs = cm.getMessages();
    const summaryMsg = msgs[1];
    expect(summaryMsg.role).toBe('user');
    expect(typeof summaryMsg.content).toBe('string');
    expect((summaryMsg.content as string)).toContain(longContent.slice(0, 120));
    expect((summaryMsg.content as string)).toContain(longContent.slice(-40));
  });

  it('treats get_page_info as content-bearing during compression', () => {
    const cm = new ConversationManager({
      compressThreshold: 8,
      keepRecent: 3,
    });
    const structured = JSON.stringify({
      page: { url: 'https://example.com', title: 'Example' },
      elements: Array.from({ length: 40 }, (_, i) => ({ id: `el_${i}`, label: `Element ${i}` })),
    });
    cm.init('sys', [], 'task');
    cm.push({
      role: 'assistant',
      content: 'Inspecting page',
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'get_page_info', arguments: '{}' } }],
    } as any);
    cm.push({ role: 'tool', tool_call_id: 'tc1', content: structured } as any);
    cm.push({ role: 'assistant', content: 'step 1' });
    cm.push({ role: 'assistant', content: 'step 2' });
    cm.push({ role: 'assistant', content: 'step 3' });
    cm.push({ role: 'assistant', content: 'step 4' });
    cm.push({ role: 'assistant', content: 'step 5' });

    const summaryMsg = cm.getMessages()[1];
    expect(typeof summaryMsg.content).toBe('string');
    expect(summaryMsg.content as string).toContain('el_0');
  });
});
