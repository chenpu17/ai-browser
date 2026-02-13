import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { CardIndex, CardIndexEntry, KnowledgeCard, SitePattern } from './types.js';

const MAX_DOMAINS = 200;
const MAX_PATTERNS_PER_DOMAIN = 30;
const MAX_ARCHIVES_PER_DOMAIN = 5;
const MAX_CACHE_SIZE = 10;
const FLUSH_DELAY = 5000;
const ARCHIVE_CHANGE_THRESHOLD = 0.5; // archive when >50% patterns changed
const CONFIDENCE_DECAY_BASE = 0.95;
const MIN_CONFIDENCE = 0.1;

/** Guard against path traversal: only allow safe domain/filename strings */
export function isSafeDomain(domain: string): boolean {
  return /^[a-zA-Z0-9][-a-zA-Z0-9.]*\.[a-zA-Z]{2,}$/.test(domain) && !domain.includes('..');
}
function isSafeFilename(name: string): boolean {
  return /^[a-zA-Z0-9][-a-zA-Z0-9_.]*\.json$/.test(name) && !name.includes('..');
}

export class KnowledgeCardStore {
  private index: CardIndex;
  private cardCache = new Map<string, KnowledgeCard>();
  private cacheOrder: string[] = []; // LRU tracking
  private baseDir: string;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || path.join(os.homedir(), '.ai-browser', 'memory');
    this.index = { entries: {}, updatedAt: Date.now() };
    this.loadIndex();
  }

  // === Index level (in-memory) ===

  listDomains(): CardIndexEntry[] {
    return Object.values(this.index.entries);
  }

  getIndexEntry(domain: string): CardIndexEntry | undefined {
    return this.index.entries[domain];
  }

  hasDomain(domain: string): boolean {
    return domain in this.index.entries;
  }

  // === Card level (on-demand from disk) ===

  loadCard(domain: string): KnowledgeCard | undefined {
    if (!isSafeDomain(domain)) return undefined;
    // Check cache first
    if (this.cardCache.has(domain)) {
      this.touchCache(domain);
      return this.cardCache.get(domain);
    }
    // Load from disk
    const filePath = path.join(this.baseDir, 'cards', `${domain}.json`);
    try {
      if (!fs.existsSync(filePath)) return undefined;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const card = JSON.parse(raw) as KnowledgeCard;
      this.putCache(domain, card);
      return card;
    } catch {
      return undefined;
    }
  }

  // === Write ===

  saveCard(card: KnowledgeCard): void {
    // Enforce pattern limit
    if (card.patterns.length > MAX_PATTERNS_PER_DOMAIN) {
      card.patterns.sort((a, b) => this.effectiveConfidence(b) - this.effectiveConfidence(a));
      card.patterns = card.patterns.slice(0, MAX_PATTERNS_PER_DOMAIN);
    }

    // Archive old version if needed
    const existing = this.loadCard(card.domain);
    if (existing) {
      this.archiveIfNeeded(card.domain, existing, card);
    }

    // Write card to disk
    const cardsDir = path.join(this.baseDir, 'cards');
    this.ensureDir(cardsDir);
    const filePath = path.join(cardsDir, `${card.domain}.json`);
    try {
      fs.writeFileSync(filePath, JSON.stringify(card, null, 2), 'utf-8');
    } catch { /* non-critical */ }

    // Update cache
    this.putCache(card.domain, card);

    // Update index
    this.updateIndexEntry(card);
    this.evictDomainsIfNeeded();
    this.scheduleFlush();
  }

  recordUsage(domain: string, patternValue: string): void {
    const card = this.loadCard(domain);
    if (!card) return;
    const pattern = card.patterns.find(p => p.value === patternValue);
    if (!pattern) return;
    pattern.useCount++;
    pattern.lastUsedAt = Date.now();
    // Boost confidence on successful use, cap at 1.0
    pattern.confidence = Math.min(1.0, pattern.confidence + 0.05);
    card.updatedAt = Date.now();
    this.saveCard(card);
  }

  clearDomain(domain: string): boolean {
    if (!this.hasDomain(domain)) return false;
    // Remove card file
    const filePath = path.join(this.baseDir, 'cards', `${domain}.json`);
    try { fs.unlinkSync(filePath); } catch { /* ok */ }
    // Remove from cache and index
    this.cardCache.delete(domain);
    this.cacheOrder = this.cacheOrder.filter(d => d !== domain);
    delete this.index.entries[domain];
    this.index.updatedAt = Date.now();
    this.scheduleFlush();
    return true;
  }

  // === Archive ===

  listArchives(domain: string): string[] {
    const archiveDir = path.join(this.baseDir, 'archive');
    try {
      if (!fs.existsSync(archiveDir)) return [];
      const files = fs.readdirSync(archiveDir);
      return files
        .filter(f => f.startsWith(`${domain}_`) && f.endsWith('.json'))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  loadArchive(domain: string, filename: string): KnowledgeCard | undefined {
    if (!isSafeDomain(domain) || !isSafeFilename(filename)) return undefined;
    const filePath = path.join(this.baseDir, 'archive', filename);
    try {
      if (!fs.existsSync(filePath)) return undefined;
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as KnowledgeCard;
    } catch {
      return undefined;
    }
  }

  restoreArchive(domain: string, filename: string): boolean {
    const archived = this.loadArchive(domain, filename);
    if (!archived) return false;
    archived.updatedAt = Date.now();
    archived.version++;
    this.saveCard(archived);
    return true;
  }

  private archiveIfNeeded(domain: string, oldCard: KnowledgeCard, newCard: KnowledgeCard): void {
    if (oldCard.patterns.length === 0) return;
    const oldValues = new Set(oldCard.patterns.map(p => p.value));
    const newValues = new Set(newCard.patterns.map(p => p.value));
    let changed = 0;
    for (const v of oldValues) {
      if (!newValues.has(v)) changed++;
    }
    for (const v of newValues) {
      if (!oldValues.has(v)) changed++;
    }
    const changeRatio = changed / Math.max(oldValues.size, newValues.size);
    if (changeRatio < ARCHIVE_CHANGE_THRESHOLD) return;

    const archiveDir = path.join(this.baseDir, 'archive');
    this.ensureDir(archiveDir);
    const timestamp = Math.floor(Date.now() / 1000);
    const filename = `${domain}_${timestamp}.json`;
    try {
      fs.writeFileSync(
        path.join(archiveDir, filename),
        JSON.stringify(oldCard, null, 2),
        'utf-8',
      );
    } catch { /* non-critical */ }

    // Prune old archives
    const archives = this.listArchives(domain);
    if (archives.length > MAX_ARCHIVES_PER_DOMAIN) {
      for (const old of archives.slice(MAX_ARCHIVES_PER_DOMAIN)) {
        try { fs.unlinkSync(path.join(archiveDir, old)); } catch { /* ok */ }
      }
    }
  }

  // === Maintenance ===

  runMaintenance(): void {
    let changed = false;
    for (const domain of Object.keys(this.index.entries)) {
      const card = this.loadCard(domain);
      if (!card) continue;
      const before = card.patterns.length;
      card.patterns = card.patterns.filter(p => this.effectiveConfidence(p) >= MIN_CONFIDENCE);
      if (card.patterns.length !== before) {
        card.updatedAt = Date.now();
        this.saveCard(card);
        changed = true;
      }
    }
    if (changed) this.scheduleFlush();
  }

  flushIndex(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      this.ensureDir(this.baseDir);
      const filePath = path.join(this.baseDir, 'index.json');
      fs.writeFileSync(filePath, JSON.stringify(this.index, null, 2), 'utf-8');
    } catch { /* non-critical */ }
  }

  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushIndex();
  }

  // === Private helpers ===

  private effectiveConfidence(pattern: SitePattern | { confidence: number; lastUsedAt: number }): number {
    const daysSinceUse = (Date.now() - pattern.lastUsedAt) / (1000 * 60 * 60 * 24);
    return pattern.confidence * Math.pow(CONFIDENCE_DECAY_BASE, daysSinceUse);
  }

  private loadIndex(): void {
    const filePath = path.join(this.baseDir, 'index.json');
    try {
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as CardIndex;
      if (data && typeof data.entries === 'object') {
        this.index = data;
      }
    } catch { /* start fresh */ }
  }

  private updateIndexEntry(card: KnowledgeCard): void {
    const sorted = [...card.patterns].sort(
      (a, b) => this.effectiveConfidence(b) - this.effectiveConfidence(a),
    );
    this.index.entries[card.domain] = {
      domain: card.domain,
      version: card.version,
      patternCount: card.patterns.length,
      siteType: card.siteType,
      requiresLogin: card.requiresLogin,
      topPatterns: sorted.slice(0, 3).map(p => p.description),
      lastUsedAt: Math.max(...card.patterns.map(p => p.lastUsedAt), card.updatedAt),
      updatedAt: card.updatedAt,
    };
    this.index.updatedAt = Date.now();
  }

  private evictDomainsIfNeeded(): void {
    const domains = Object.keys(this.index.entries);
    if (domains.length <= MAX_DOMAINS) return;
    // Evict least recently used
    const sorted = domains.sort(
      (a, b) => (this.index.entries[a].lastUsedAt || 0) - (this.index.entries[b].lastUsedAt || 0),
    );
    const toRemove = sorted.slice(0, domains.length - MAX_DOMAINS);
    for (const domain of toRemove) {
      this.clearDomain(domain);
    }
  }

  private putCache(domain: string, card: KnowledgeCard): void {
    this.cardCache.set(domain, card);
    this.touchCache(domain);
    // Evict LRU if over limit
    while (this.cacheOrder.length > MAX_CACHE_SIZE) {
      const evicted = this.cacheOrder.shift()!;
      this.cardCache.delete(evicted);
    }
  }

  private touchCache(domain: string): void {
    this.cacheOrder = this.cacheOrder.filter(d => d !== domain);
    this.cacheOrder.push(domain);
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushIndex();
    }, FLUSH_DELAY);
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
