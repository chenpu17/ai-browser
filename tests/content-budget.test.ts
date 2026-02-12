import { describe, it, expect } from 'vitest';
import { formatToolResult, getToolBudget } from '../src/agent/content-budget.js';

describe('content-budget', () => {
  describe('getToolBudget', () => {
    it('returns specific budget for known tools', () => {
      expect(getToolBudget('navigate')).toBe(2000);
      expect(getToolBudget('get_page_content')).toBe(6000);
      expect(getToolBudget('get_page_info')).toBe(4000);
    });

    it('returns default budget for unknown tools', () => {
      expect(getToolBudget('unknown_tool')).toBe(4000);
    });
  });

  describe('formatToolResult', () => {
    it('prioritizes aiMarkdown when within budget', () => {
      const data = {
        success: true,
        aiMarkdown: '## Navigation Result\n\n- URL: https://example.com',
        aiSummary: 'Navigation completed',
      };
      const result = formatToolResult(JSON.stringify(data), 'navigate');
      expect(result).toBe(data.aiMarkdown);
    });

    it('falls back to aiSummary when aiMarkdown exceeds budget', () => {
      const longMarkdown = 'x'.repeat(3000);
      const data = {
        success: true,
        aiMarkdown: longMarkdown,
        aiSummary: 'Navigation completed',
      };
      const result = formatToolResult(JSON.stringify(data), 'navigate');
      expect(result).toBe('Navigation completed');
    });

    it('truncates aiMarkdown when no aiSummary and over budget', () => {
      const longMarkdown = 'x'.repeat(3000);
      const data = {
        success: true,
        aiMarkdown: longMarkdown,
      };
      const result = formatToolResult(JSON.stringify(data), 'navigate');
      expect(result.length).toBeLessThanOrEqual(2100); // budget + truncation notice
      expect(result).toContain('已截断');
    });

    it('uses aiSummary when no aiMarkdown', () => {
      const data = { success: true, aiSummary: 'Done' };
      const result = formatToolResult(JSON.stringify(data), 'click');
      expect(result).toBe('Done');
    });

    it('falls back to legacy formatting for get_page_info', () => {
      const data = {
        page: { url: 'https://example.com', title: 'Test' },
        elements: Array.from({ length: 5 }, (_, i) => ({
          id: `el_${i}`, type: 'button', label: `Button ${i}`,
        })),
        intents: ['search'],
      };
      const result = formatToolResult(JSON.stringify(data), 'get_page_info');
      expect(result).toContain('elementCount');
      expect(result).toContain('el_0');
    });

    it('falls back to legacy formatting for get_page_content', () => {
      const data = {
        title: 'Test Page',
        sections: [
          { text: 'Important content', attention: 0.8 },
          { text: 'Less important', attention: 0.3 },
        ],
      };
      const result = formatToolResult(JSON.stringify(data), 'get_page_content');
      expect(result).toContain('Test Page');
      expect(result).toContain('Important content');
    });

    it('handles non-JSON input gracefully', () => {
      const result = formatToolResult('not json', 'navigate');
      expect(result).toBe('not json');
    });

    it('truncates very long raw text', () => {
      const longText = 'a'.repeat(10000);
      const result = formatToolResult(longText, 'navigate');
      expect(result.length).toBeLessThanOrEqual(8100);
    });
  });
});
