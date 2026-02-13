import { describe, it, expect } from 'vitest';
import { MemoryInjector, relevanceScore } from '../src/memory/MemoryInjector.js';
import type { KnowledgeCard } from '../src/memory/types.js';

describe('MemoryInjector', () => {
  describe('extractDomain', () => {
    it('extracts domain from URL in task', () => {
      expect(MemoryInjector.extractDomain('打开 https://www.bilibili.com/ranking 获取排行榜')).toBe('bilibili.com');
    });

    it('extracts domain from domain-like pattern', () => {
      expect(MemoryInjector.extractDomain('去 jd.com 搜索手机')).toBe('jd.com');
    });

    it('extracts domain from Chinese site name', () => {
      expect(MemoryInjector.extractDomain('去B站看排行榜')).toBe('bilibili.com');
      expect(MemoryInjector.extractDomain('在京东搜索笔记本')).toBe('jd.com');
      expect(MemoryInjector.extractDomain('打开知乎热榜')).toBe('zhihu.com');
      expect(MemoryInjector.extractDomain('查看36氪新闻')).toBe('36kr.com');
    });

    it('returns null for unrecognized task', () => {
      expect(MemoryInjector.extractDomain('帮我写一段代码')).toBeNull();
    });

    it('handles bilibili variants', () => {
      expect(MemoryInjector.extractDomain('去哔哩哔哩看视频')).toBe('bilibili.com');
      expect(MemoryInjector.extractDomain('去b站看视频')).toBe('bilibili.com');
    });
  });

  describe('buildContext', () => {
    const now = Date.now();

    function makeCard(overrides: Partial<KnowledgeCard> = {}): KnowledgeCard {
      return {
        domain: 'bilibili.com',
        version: 1,
        patterns: [
          {
            type: 'selector',
            description: '排行榜项使用 .rank-item',
            value: '.rank-item',
            confidence: 0.92,
            useCount: 3,
            lastUsedAt: now,
            createdAt: now,
            source: 'agent_auto',
          },
        ],
        siteType: 'spa',
        createdAt: now,
        updatedAt: now,
        ...overrides,
      };
    }

    it('generates context with domain header', () => {
      const ctx = MemoryInjector.buildContext(makeCard());
      expect(ctx).toContain('## 站点记忆: bilibili.com [SPA]');
    });

    it('includes pattern details', () => {
      const ctx = MemoryInjector.buildContext(makeCard());
      expect(ctx).toContain('.rank-item');
      expect(ctx).toContain('用过3次');
    });

    it('includes warning footer', () => {
      const ctx = MemoryInjector.buildContext(makeCard());
      expect(ctx).toContain('⚠️');
    });

    it('shows login requirement', () => {
      const ctx = MemoryInjector.buildContext(makeCard({ requiresLogin: true }));
      expect(ctx).toContain('需要登录: 是');
    });

    it('respects maxChars limit', () => {
      const patterns = Array.from({ length: 20 }, (_, i) => ({
        type: 'selector' as const,
        description: `pattern ${i} with a long description that takes up space`,
        value: `.selector-${i}`,
        confidence: 0.9,
        useCount: 1,
        lastUsedAt: now,
        createdAt: now,
        source: 'agent_auto' as const,
      }));
      const ctx = MemoryInjector.buildContext(makeCard({ patterns }), 500);
      expect(ctx.length).toBeLessThanOrEqual(500);
    });

    it('sorts by effective confidence', () => {
      const patterns = [
        {
          type: 'selector' as const,
          description: 'low confidence',
          value: '.low',
          confidence: 0.3,
          useCount: 1,
          lastUsedAt: now,
          createdAt: now,
          source: 'agent_auto' as const,
        },
        {
          type: 'selector' as const,
          description: 'high confidence',
          value: '.high',
          confidence: 0.95,
          useCount: 5,
          lastUsedAt: now,
          createdAt: now,
          source: 'agent_auto' as const,
        },
      ];
      const ctx = MemoryInjector.buildContext(makeCard({ patterns }));
      const highIdx = ctx.indexOf('.high');
      const lowIdx = ctx.indexOf('.low');
      expect(highIdx).toBeLessThan(lowIdx);
    });

    it('sorts task_intent by relevance when taskHint provided', () => {
      const patterns = [
        {
          type: 'task_intent' as const,
          description: '',
          value: '在京东搜索手机并比价',
          confidence: 0.9,
          useCount: 2,
          lastUsedAt: now - 10000,
          createdAt: now,
          source: 'agent_auto' as const,
        },
        {
          type: 'task_intent' as const,
          description: '',
          value: '获取B站排行榜视频列表',
          confidence: 0.9,
          useCount: 1,
          lastUsedAt: now,
          createdAt: now,
          source: 'agent_auto' as const,
        },
      ];
      const ctx = MemoryInjector.buildContext(makeCard({ patterns }), 2000, '搜索手机');
      const jdIdx = ctx.indexOf('京东搜索手机');
      const biliIdx = ctx.indexOf('排行榜视频');
      expect(jdIdx).toBeGreaterThan(-1);
      expect(biliIdx).toBeGreaterThan(-1);
      // 搜索手机 matches the first intent better
      expect(jdIdx).toBeLessThan(biliIdx);
    });

    it('falls back to recency without taskHint', () => {
      const patterns = [
        {
          type: 'task_intent' as const,
          description: '',
          value: '旧任务',
          confidence: 0.9,
          useCount: 1,
          lastUsedAt: now - 100000,
          createdAt: now,
          source: 'agent_auto' as const,
        },
        {
          type: 'task_intent' as const,
          description: '',
          value: '新任务',
          confidence: 0.9,
          useCount: 1,
          lastUsedAt: now,
          createdAt: now,
          source: 'agent_auto' as const,
        },
      ];
      const ctx = MemoryInjector.buildContext(makeCard({ patterns }));
      const newIdx = ctx.indexOf('新任务');
      const oldIdx = ctx.indexOf('旧任务');
      expect(newIdx).toBeLessThan(oldIdx);
    });

    it('filters non-global patterns by taskHint relevance', () => {
      const patterns = [
        {
          type: 'selector' as const,
          description: '搜索框',
          value: '.search-input',
          confidence: 0.9,
          useCount: 2,
          lastUsedAt: now,
          createdAt: now,
          source: 'agent_auto' as const,
        },
        {
          type: 'selector' as const,
          description: '排行榜项',
          value: '.rank-item',
          confidence: 0.9,
          useCount: 3,
          lastUsedAt: now,
          createdAt: now,
          source: 'agent_auto' as const,
        },
        {
          type: 'navigation_path' as const,
          description: '排行榜页面',
          value: '/ranking',
          confidence: 0.9,
          useCount: 2,
          lastUsedAt: now,
          createdAt: now,
          source: 'agent_auto' as const,
        },
        {
          type: 'spa_hint' as const,
          description: '路由切换需等待',
          value: 'spa',
          confidence: 0.9,
          useCount: 1,
          lastUsedAt: now,
          createdAt: now,
          source: 'agent_auto' as const,
        },
      ];
      const ctx = MemoryInjector.buildContext(makeCard({ patterns }), 2000, '搜索');
      // 搜索框 matches '搜索', should be included
      expect(ctx).toContain('.search-input');
      // 排行榜项 does NOT match '搜索', should be filtered out
      expect(ctx).not.toContain('.rank-item');
      // /ranking does NOT match '搜索', should be filtered out
      expect(ctx).not.toContain('/ranking');
      // spa_hint is global, always included
      expect(ctx).toContain('路由切换需等待');
    });

    it('includes all patterns when no taskHint', () => {
      const patterns = [
        {
          type: 'selector' as const,
          description: '搜索框',
          value: '.search-input',
          confidence: 0.9,
          useCount: 1,
          lastUsedAt: now,
          createdAt: now,
          source: 'agent_auto' as const,
        },
        {
          type: 'selector' as const,
          description: '排行榜项',
          value: '.rank-item',
          confidence: 0.9,
          useCount: 1,
          lastUsedAt: now,
          createdAt: now,
          source: 'agent_auto' as const,
        },
      ];
      const ctx = MemoryInjector.buildContext(makeCard({ patterns }));
      expect(ctx).toContain('.search-input');
      expect(ctx).toContain('.rank-item');
    });
  });

  describe('relevanceScore', () => {
    it('returns longest matching substring length', () => {
      expect(relevanceScore('在京东搜索手机并比价', '搜索手机')).toBe(4);
    });

    it('returns 0 for hint shorter than 2 chars', () => {
      expect(relevanceScore('搜索手机', '搜')).toBe(0);
    });

    it('returns 0 when no substring matches', () => {
      expect(relevanceScore('获取排行榜', '搜索手机')).toBe(0);
    });

    it('is case insensitive', () => {
      expect(relevanceScore('Search on Google', 'google')).toBe(6);
    });

    it('works with partial CJK matches', () => {
      // '视频' is a 2-char substring of '搜索视频'
      expect(relevanceScore('获取B站排行榜视频列表', '搜索视频')).toBeGreaterThanOrEqual(2);
    });
  });

  describe('countPatternTypes', () => {
    it('counts patterns by type', () => {
      const patterns = [
        { type: 'selector', value: '.a', description: '', confidence: 0.9, useCount: 1, lastUsedAt: 0, createdAt: 0, source: 'agent_auto' as const },
        { type: 'selector', value: '.b', description: '', confidence: 0.9, useCount: 1, lastUsedAt: 0, createdAt: 0, source: 'agent_auto' as const },
        { type: 'task_intent', value: 'x', description: '', confidence: 0.9, useCount: 1, lastUsedAt: 0, createdAt: 0, source: 'agent_auto' as const },
      ];
      const counts = MemoryInjector.countPatternTypes(patterns);
      expect(counts).toEqual({ selector: 2, task_intent: 1 });
    });

    it('returns empty object for empty patterns', () => {
      expect(MemoryInjector.countPatternTypes([])).toEqual({});
    });
  });
});
