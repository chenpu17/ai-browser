import { describe, it, expect } from 'vitest';
import { determineRecovery, extractErrorCode } from '../src/agent/error-recovery.js';

describe('error-recovery', () => {
  describe('determineRecovery', () => {
    it('aborts on PAGE_CRASHED', () => {
      const result = determineRecovery({
        errorCode: 'PAGE_CRASHED',
        errorMessage: 'Page crashed',
        toolName: 'click',
        consecutiveErrors: 1,
      });
      expect(result.type).toBe('abort');
    });

    it('aborts on SESSION_NOT_FOUND', () => {
      const result = determineRecovery({
        errorCode: 'SESSION_NOT_FOUND',
        errorMessage: 'Session not found',
        toolName: 'click',
        consecutiveErrors: 1,
      });
      expect(result.type).toBe('abort');
    });

    it('injects hint on ELEMENT_NOT_FOUND', () => {
      const result = determineRecovery({
        errorCode: 'ELEMENT_NOT_FOUND',
        errorMessage: 'Element not found: btn_123',
        toolName: 'click',
        consecutiveErrors: 1,
      });
      expect(result.type).toBe('inject_hint');
      if (result.type === 'inject_hint') {
        expect(result.message).toContain('get_page_info');
      }
    });

    it('retries with backoff on NAVIGATION_TIMEOUT (first error)', () => {
      const result = determineRecovery({
        errorCode: 'NAVIGATION_TIMEOUT',
        errorMessage: 'Navigation timeout',
        toolName: 'navigate',
        consecutiveErrors: 1,
      });
      expect(result.type).toBe('retry');
      if (result.type === 'retry') {
        expect(result.delayMs).toBe(2000);
      }
    });

    it('injects hint on NAVIGATION_TIMEOUT after 3 errors', () => {
      const result = determineRecovery({
        errorCode: 'NAVIGATION_TIMEOUT',
        errorMessage: 'Navigation timeout',
        toolName: 'navigate',
        consecutiveErrors: 3,
      });
      expect(result.type).toBe('inject_hint');
    });

    it('uses exponential backoff for LLM errors', () => {
      const r1 = determineRecovery({
        errorMessage: 'ECONNREFUSED',
        toolName: '_llm_api',
        consecutiveErrors: 1,
      });
      const r2 = determineRecovery({
        errorMessage: 'ECONNREFUSED',
        toolName: '_llm_api',
        consecutiveErrors: 2,
      });
      expect(r1.type).toBe('retry');
      expect(r2.type).toBe('retry');
      if (r1.type === 'retry' && r2.type === 'retry') {
        expect(r2.delayMs).toBeGreaterThan(r1.delayMs);
      }
    });

    it('caps retry delay at 16s', () => {
      const result = determineRecovery({
        errorMessage: 'ECONNREFUSED',
        toolName: '_llm_api',
        consecutiveErrors: 10,
      });
      if (result.type === 'retry') {
        expect(result.delayMs).toBeLessThanOrEqual(16000);
      }
    });
  });

  describe('extractErrorCode', () => {
    it('extracts errorCode from JSON', () => {
      const raw = JSON.stringify({ error: 'Not found', errorCode: 'ELEMENT_NOT_FOUND' });
      expect(extractErrorCode(raw)).toBe('ELEMENT_NOT_FOUND');
    });

    it('returns undefined for no errorCode', () => {
      expect(extractErrorCode(JSON.stringify({ error: 'fail' }))).toBeUndefined();
    });

    it('returns undefined for non-JSON', () => {
      expect(extractErrorCode('not json')).toBeUndefined();
    });
  });
});
