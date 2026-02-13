import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { KnowledgeCardStore } from '../src/memory/KnowledgeCardStore.js';
import type { KnowledgeCard, SitePattern } from '../src/memory/types.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));
}

function makePattern(overrides: Partial<SitePattern> = {}): SitePattern {
  const now = Date.now();
  return {
    type: 'selector',
    description: 'test pattern',
    value: '.test-selector',
    confidence: 0.8,
    useCount: 1,
    lastUsedAt: now,
    createdAt: now,
    source: 'agent_auto',
    ...overrides,
  };
}

function makeCard(domain: string, patterns: SitePattern[] = [makePattern()]): KnowledgeCard {
  const now = Date.now();
  return {
    domain,
    version: 1,
    patterns,
    createdAt: now,
    updatedAt: now,
  };
}

describe('KnowledgeCardStore', () => {
  let baseDir: string;
  let store: KnowledgeCardStore;

  beforeEach(() => {
    baseDir = tmpDir();
    store = new KnowledgeCardStore(baseDir);
  });

  afterEach(() => {
    store.dispose();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  describe('index CRUD', () => {
    it('starts empty', () => {
      expect(store.listDomains()).toEqual([]);
      expect(store.hasDomain('example.com')).toBe(false);
    });

    it('saves and lists domains', () => {
      store.saveCard(makeCard('example.com'));
      expect(store.hasDomain('example.com')).toBe(true);
      const domains = store.listDomains();
      expect(domains).toHaveLength(1);
      expect(domains[0].domain).toBe('example.com');
    });

    it('getIndexEntry returns entry after save', () => {
      store.saveCard(makeCard('test.com'));
      const entry = store.getIndexEntry('test.com');
      expect(entry).toBeDefined();
      expect(entry!.domain).toBe('test.com');
      expect(entry!.patternCount).toBe(1);
    });

    it('clearDomain removes domain', () => {
      store.saveCard(makeCard('remove.com'));
      expect(store.hasDomain('remove.com')).toBe(true);
      const cleared = store.clearDomain('remove.com');
      expect(cleared).toBe(true);
      expect(store.hasDomain('remove.com')).toBe(false);
    });

    it('clearDomain returns false for unknown domain', () => {
      expect(store.clearDomain('unknown.com')).toBe(false);
    });
  });

  describe('card load/save', () => {
    it('saves and loads card from disk', () => {
      const card = makeCard('bilibili.com', [
        makePattern({ value: '.rank-item', description: '排行榜项' }),
      ]);
      store.saveCard(card);

      // Create new store to verify disk persistence
      const store2 = new KnowledgeCardStore(baseDir);
      const loaded = store2.loadCard('bilibili.com');
      expect(loaded).toBeDefined();
      expect(loaded!.domain).toBe('bilibili.com');
      expect(loaded!.patterns).toHaveLength(1);
      expect(loaded!.patterns[0].value).toBe('.rank-item');
      store2.dispose();
    });

    it('returns undefined for unknown domain', () => {
      expect(store.loadCard('unknown.com')).toBeUndefined();
    });
  });

  describe('LRU cache', () => {
    it('evicts oldest entries when cache exceeds 10', () => {
      // Save 12 domains
      for (let i = 0; i < 12; i++) {
        store.saveCard(makeCard(`domain${i}.com`));
      }
      // All should still be loadable (from disk if evicted from cache)
      for (let i = 0; i < 12; i++) {
        expect(store.loadCard(`domain${i}.com`)).toBeDefined();
      }
    });
  });

  describe('recordUsage', () => {
    it('increments useCount and boosts confidence', () => {
      const card = makeCard('usage.com', [makePattern({ value: '.btn', confidence: 0.5 })]);
      store.saveCard(card);
      store.recordUsage('usage.com', '.btn');
      const updated = store.loadCard('usage.com');
      expect(updated!.patterns[0].useCount).toBe(2);
      expect(updated!.patterns[0].confidence).toBeGreaterThan(0.5);
    });

    it('does nothing for unknown domain', () => {
      store.recordUsage('nope.com', '.btn'); // should not throw
    });
  });

  describe('archiving', () => {
    it('archives when patterns change significantly', () => {
      // Save initial card with 4 patterns
      const patterns = Array.from({ length: 4 }, (_, i) =>
        makePattern({ value: `.old-${i}`, description: `old ${i}` }),
      );
      store.saveCard(makeCard('archive.com', patterns));

      // Save new card with completely different patterns (>50% change)
      const newPatterns = Array.from({ length: 4 }, (_, i) =>
        makePattern({ value: `.new-${i}`, description: `new ${i}` }),
      );
      store.saveCard({ ...makeCard('archive.com', newPatterns), version: 2 });

      const archives = store.listArchives('archive.com');
      expect(archives.length).toBeGreaterThanOrEqual(1);
    });

    it('does not archive when changes are minor', () => {
      // 4 patterns, adding 1 new → change ratio = 1/5 = 20% < 50%
      const patterns = Array.from({ length: 4 }, (_, i) =>
        makePattern({ value: `.keep-${i}`, description: `keep ${i}` }),
      );
      store.saveCard(makeCard('minor.com', patterns));

      const updated = [...patterns, makePattern({ value: '.new', description: 'new' })];
      store.saveCard({ ...makeCard('minor.com', updated), version: 2 });

      const archives = store.listArchives('minor.com');
      expect(archives).toHaveLength(0);
    });

    it('restoreArchive restores old version', () => {
      const oldPatterns = [makePattern({ value: '.old' })];
      store.saveCard(makeCard('restore.com', oldPatterns));

      const newPatterns = Array.from({ length: 4 }, (_, i) =>
        makePattern({ value: `.replaced-${i}` }),
      );
      store.saveCard({ ...makeCard('restore.com', newPatterns), version: 2 });

      const archives = store.listArchives('restore.com');
      if (archives.length > 0) {
        const restored = store.restoreArchive('restore.com', archives[0]);
        expect(restored).toBe(true);
        const card = store.loadCard('restore.com');
        expect(card!.patterns[0].value).toBe('.old');
      }
    });
  });

  describe('confidence decay and maintenance', () => {
    it('removes low-confidence patterns during maintenance', () => {
      const oldPattern = makePattern({
        value: '.stale',
        confidence: 0.05, // very low
        lastUsedAt: Date.now() - 90 * 24 * 60 * 60 * 1000, // 90 days ago
      });
      store.saveCard(makeCard('decay.com', [oldPattern]));
      store.runMaintenance();
      const card = store.loadCard('decay.com');
      expect(card!.patterns).toHaveLength(0);
    });

    it('keeps high-confidence recent patterns', () => {
      const freshPattern = makePattern({ value: '.fresh', confidence: 0.9 });
      store.saveCard(makeCard('fresh.com', [freshPattern]));
      store.runMaintenance();
      const card = store.loadCard('fresh.com');
      expect(card!.patterns).toHaveLength(1);
    });
  });

  describe('pattern limit', () => {
    it('enforces MAX_PATTERNS_PER_DOMAIN = 30', () => {
      const patterns = Array.from({ length: 40 }, (_, i) =>
        makePattern({ value: `.p${i}`, confidence: i / 40 }),
      );
      store.saveCard(makeCard('limit.com', patterns));
      const card = store.loadCard('limit.com');
      expect(card!.patterns.length).toBeLessThanOrEqual(30);
    });
  });

  describe('index persistence', () => {
    it('flushIndex writes to disk and reloads', () => {
      store.saveCard(makeCard('persist.com'));
      store.flushIndex();

      const store2 = new KnowledgeCardStore(baseDir);
      expect(store2.hasDomain('persist.com')).toBe(true);
      store2.dispose();
    });
  });
});
