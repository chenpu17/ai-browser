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
}
