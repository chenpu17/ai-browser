import { describe, it, expect } from 'vitest';
import { MemoryCapturer, mergePatterns } from '../src/memory/MemoryCapturer.js';
import type { ToolCallRecord } from '../src/agent/tool-usage-tracker.js';
import type { SitePattern } from '../src/memory/types.js';

describe('MemoryCapturer', () => {
  describe('extractDomain', () => {
    it('extracts domain from URL', () => {
      expect(MemoryCapturer.extractDomain('https://www.bilibili.com/ranking')).toBe('bilibili.com');
    });

    it('handles www prefix', () => {
      expect(MemoryCapturer.extractDomain('https://www.jd.com/products')).toBe('jd.com');
    });

    it('handles two-part TLDs', () => {
      expect(MemoryCapturer.extractDomain('https://weather.com.cn/forecast')).toBe('weather.com.cn');
    });

    it('handles subdomains', () => {
      expect(MemoryCapturer.extractDomain('https://m.bilibili.com/video')).toBe('bilibili.com');
    });

    it('returns empty for invalid URL', () => {
      expect(MemoryCapturer.extractDomain('not-a-url')).toBe('');
    });

    it('handles simple domains', () => {
      expect(MemoryCapturer.extractDomain('https://example.com')).toBe('example.com');
    });
  });

  describe('extractPatterns', () => {
    const now = Date.now();

    it('extracts selector from execute_javascript with querySelector', () => {
      const history: ToolCallRecord[] = [
        {
          toolName: 'execute_javascript',
          args: { script: "document.querySelectorAll('.rank-item').length" },
          success: true,
          timestamp: now,
        },
      ];
      const patterns = MemoryCapturer.extractPatterns(history, 'https://bilibili.com/ranking');
      expect(patterns.some(p => p.type === 'selector' && p.value === '.rank-item')).toBe(true);
    });

    it('extracts navigation_path from consecutive navigations', () => {
      const history: ToolCallRecord[] = [
        { toolName: 'navigate', args: { url: 'https://example.com/a' }, success: true, timestamp: now },
        { toolName: 'navigate', args: { url: 'https://example.com/b' }, success: true, timestamp: now + 1 },
      ];
      const patterns = MemoryCapturer.extractPatterns(history, 'https://example.com/b');
      expect(patterns.some(p => p.type === 'navigation_path')).toBe(true);
    });

    it('extracts login_required from ask_human with login keyword', () => {
      const history: ToolCallRecord[] = [
        { toolName: 'ask_human', args: { question: '请输入登录密码' }, success: true, timestamp: now },
      ];
      const patterns = MemoryCapturer.extractPatterns(history, 'https://jd.com');
      expect(patterns.some(p => p.type === 'login_required')).toBe(true);
    });

    it('extracts spa_hint from get_page_content + execute_javascript', () => {
      const history: ToolCallRecord[] = [
        { toolName: 'get_page_content', args: {}, success: true, timestamp: now },
        { toolName: 'execute_javascript', args: { script: 'document.querySelector(".app")' }, success: true, timestamp: now + 1 },
      ];
      const patterns = MemoryCapturer.extractPatterns(history, 'https://spa.com');
      expect(patterns.some(p => p.type === 'spa_hint')).toBe(true);
    });

    it('extracts page_structure from get_page_info', () => {
      const history: ToolCallRecord[] = [
        { toolName: 'get_page_info', args: {}, success: true, timestamp: now },
      ];
      const patterns = MemoryCapturer.extractPatterns(history, 'https://example.com/page');
      expect(patterns.some(p => p.type === 'page_structure')).toBe(true);
    });

    it('skips failed tool calls', () => {
      const history: ToolCallRecord[] = [
        { toolName: 'execute_javascript', args: { script: "querySelector('.fail')" }, success: false, timestamp: now },
      ];
      const patterns = MemoryCapturer.extractPatterns(history, 'https://example.com');
      expect(patterns).toHaveLength(0);
    });

    it('deduplicates patterns by value', () => {
      const history: ToolCallRecord[] = [
        { toolName: 'execute_javascript', args: { script: "querySelector('.dup')" }, success: true, timestamp: now },
        { toolName: 'execute_javascript', args: { script: "querySelector('.dup')" }, success: true, timestamp: now + 1 },
      ];
      const patterns = MemoryCapturer.extractPatterns(history, 'https://example.com');
      const selectors = patterns.filter(p => p.value === '.dup');
      expect(selectors).toHaveLength(1);
    });
  });

  describe('mergePatterns', () => {
    it('merges new patterns with existing', () => {
      const now = Date.now();
      const existing: SitePattern[] = [
        { type: 'selector', description: 'old', value: '.old', confidence: 0.5, useCount: 1, lastUsedAt: now, createdAt: now, source: 'agent_auto' },
      ];
      const incoming: SitePattern[] = [
        { type: 'selector', description: 'new', value: '.new', confidence: 0.6, useCount: 1, lastUsedAt: now, createdAt: now, source: 'agent_auto' },
      ];
      const merged = mergePatterns(existing, incoming);
      expect(merged).toHaveLength(2);
    });

    it('boosts confidence for duplicate values', () => {
      const now = Date.now();
      const existing: SitePattern[] = [
        { type: 'selector', description: 'same', value: '.same', confidence: 0.5, useCount: 1, lastUsedAt: now, createdAt: now, source: 'agent_auto' },
      ];
      const incoming: SitePattern[] = [
        { type: 'selector', description: 'same', value: '.same', confidence: 0.6, useCount: 1, lastUsedAt: now, createdAt: now, source: 'agent_auto' },
      ];
      const merged = mergePatterns(existing, incoming);
      expect(merged).toHaveLength(1);
      expect(merged[0].confidence).toBeGreaterThan(0.5);
      expect(merged[0].useCount).toBe(2);
    });
  });
});
