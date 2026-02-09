import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Cookie record with at least name/domain/path for merge key */
interface CookieRecord {
  name: string;
  domain?: string;
  path?: string;
  [key: string]: any;
}

const MAX_DOMAINS = 200;

export class CookieStore {
  private store: Map<string, CookieRecord[]> = new Map();
  private filePath: string;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly FLUSH_DELAY = 5000;

  constructor(filePath?: string) {
    this.filePath = filePath || path.join(os.homedir(), '.ai-browser', 'cookies.json');
    this.loadFromDisk();
  }

  /** Save cookies, merging by name+domain+path instead of overwriting */
  save(url: string, cookies: CookieRecord[]): void {
    if (!cookies || cookies.length === 0) return;
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return;
    }

    // Group incoming cookies by their actual domain (from cookie itself)
    const byDomain = new Map<string, CookieRecord[]>();
    for (const c of cookies) {
      const domain = c.domain || hostname;
      const list = byDomain.get(domain) || [];
      list.push(c);
      byDomain.set(domain, list);
    }

    for (const [domain, incoming] of byDomain) {
      const existing = this.store.get(domain) || [];
      // Merge: replace existing cookies with same name+path
      const merged = new Map<string, CookieRecord>();
      for (const c of existing) {
        merged.set(`${c.name}|${c.path}`, c);
      }
      for (const c of incoming) {
        merged.set(`${c.name}|${c.path}`, c);
      }
      this.store.set(domain, [...merged.values()]);
    }

    this.evictIfNeeded();
    this.scheduleDiskFlush();
  }

  /** Get cookies matching the URL's hostname (including parent domain cookies) */
  getForUrl(url: string): CookieRecord[] {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return [];
    }

    const result: CookieRecord[] = [];
    for (const [domain, cookies] of this.store) {
      if (this.domainMatches(hostname, domain)) {
        result.push(...cookies);
      }
    }
    return result;
  }

  /** Get ALL cookies from the store (for injecting into new browser contexts) */
  getAll(): CookieRecord[] {
    const result: CookieRecord[] = [];
    for (const cookies of this.store.values()) {
      result.push(...cookies);
    }
    return result;
  }

  /** Check if hostname matches a cookie domain (supports subdomain matching) */
  private domainMatches(hostname: string, cookieDomain: string): boolean {
    // Exact match
    if (hostname === cookieDomain) return true;
    // Cookie domain with leading dot: .example.com matches sub.example.com
    const normalized = cookieDomain.startsWith('.')
      ? cookieDomain
      : '.' + cookieDomain;
    return hostname.endsWith(normalized) ||
      ('.' + hostname) === normalized;
  }

  /** Evict oldest domains when store exceeds MAX_DOMAINS */
  private evictIfNeeded(): void {
    if (this.store.size <= MAX_DOMAINS) return;
    const keys = [...this.store.keys()];
    const toRemove = keys.slice(0, keys.length - MAX_DOMAINS);
    for (const key of toRemove) {
      this.store.delete(key);
    }
  }

  // ===== Disk persistence =====

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, CookieRecord[]>;
      for (const [domain, cookies] of Object.entries(data)) {
        if (Array.isArray(cookies)) {
          this.store.set(domain, cookies);
        }
      }
    } catch {
      // Corrupted or missing file, start fresh
    }
  }

  private scheduleDiskFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushToDisk();
    }, this.FLUSH_DELAY);
  }

  /** Immediately write cookies to disk */
  flushToDisk(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data: Record<string, CookieRecord[]> = {};
      for (const [domain, cookies] of this.store) {
        data[domain] = cookies;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // Disk write failure, non-critical
    }
  }

  /** Stop flush timer and write pending changes */
  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushToDisk();
  }
}
