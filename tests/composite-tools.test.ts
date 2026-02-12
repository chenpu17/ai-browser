import { describe, it, expect } from 'vitest';
import { enrichWithAiMarkdown } from '../src/mcp/ai-markdown.js';

describe('Composite Tools - ai-markdown', () => {
  describe('fill_form', () => {
    it('enriches fill_form result with aiMarkdown', () => {
      const data = {
        results: [
          { elementId: 'input_name', success: true },
          { elementId: 'input_email', success: false, error: 'Element not found' },
        ],
        submitResult: { success: true, page: { url: 'https://example.com/done', title: 'Done' } },
      };
      const enriched = enrichWithAiMarkdown('fill_form', data) as any;
      expect(enriched.aiMarkdown).toContain('Fill Form Result');
      expect(enriched.aiMarkdown).toContain('input_name');
      expect(enriched.aiMarkdown).toContain('input_email');
      expect(enriched.aiMarkdown).toContain('Submit Result');
      expect(enriched.aiSummary).toContain('1/2 fields succeeded');
      expect(enriched.aiHints.length).toBeGreaterThan(0);
    });

    it('generates nextActions for failed fields', () => {
      const data = {
        results: [
          { elementId: 'input_1', success: false, error: 'not found' },
        ],
      };
      const enriched = enrichWithAiMarkdown('fill_form', data) as any;
      expect(enriched.nextActions.some((a: any) => a.tool === 'type_text')).toBe(true);
    });
  });

  describe('click_and_wait', () => {
    it('enriches click_and_wait result with aiMarkdown', () => {
      const data = {
        clickResult: { success: true, page: { url: 'https://example.com', title: 'Home' } },
        waitResult: { success: true },
      };
      const enriched = enrichWithAiMarkdown('click_and_wait', data) as any;
      expect(enriched.aiMarkdown).toContain('Click and Wait Result');
      expect(enriched.aiMarkdown).toContain('Click Success: yes');
      expect(enriched.aiMarkdown).toContain('Wait Success: yes');
      expect(enriched.aiSummary).toContain('click=yes');
    });

    it('suggests wait_for_stable when wait fails', () => {
      const data = {
        clickResult: { success: true },
        waitResult: { success: false, reason: 'timeout' },
      };
      const enriched = enrichWithAiMarkdown('click_and_wait', data) as any;
      expect(enriched.nextActions.some((a: any) => a.tool === 'wait_for_stable')).toBe(true);
    });
  });

  describe('navigate_and_extract', () => {
    it('enriches navigate_and_extract result with aiMarkdown', () => {
      const data = {
        navigateResult: {
          success: true,
          page: { url: 'https://example.com', title: 'Example' },
          statusCode: 200,
        },
        extractResult: {
          sections: [
            { text: 'Hello world' },
            { text: 'More content here' },
          ],
        },
      };
      const enriched = enrichWithAiMarkdown('navigate_and_extract', data) as any;
      expect(enriched.aiMarkdown).toContain('Navigate and Extract Result');
      expect(enriched.aiMarkdown).toContain('Hello world');
      expect(enriched.aiSummary).toContain('nav=yes');
      expect(enriched.aiSummary).toContain('Example');
    });

    it('suggests get_page_content when no sections extracted', () => {
      const data = {
        navigateResult: { success: true, page: { url: 'https://example.com', title: 'X' } },
        extractResult: { sections: [] },
      };
      const enriched = enrichWithAiMarkdown('navigate_and_extract', data) as any;
      expect(enriched.nextActions.some((a: any) => a.tool === 'get_page_content')).toBe(true);
    });
  });
});
