/** Single site pattern learned from browsing */
export interface SitePattern {
  type: 'selector' | 'navigation_path' | 'login_required' | 'spa_hint' | 'page_structure' | 'task_intent';
  description: string;
  value: string;
  urlPattern?: string;
  confidence: number;       // 0-1, decays over time
  useCount: number;
  lastUsedAt: number;
  createdAt: number;
  source: 'agent_auto' | 'human_recording' | 'manual';
}

/** Knowledge card — all memory for a single domain */
export interface KnowledgeCard {
  domain: string;
  version: number;
  patterns: SitePattern[];
  siteType?: 'spa' | 'ssr' | 'unknown';
  requiresLogin?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Lightweight index entry, kept in memory */
export interface CardIndexEntry {
  domain: string;
  version: number;
  patternCount: number;
  siteType?: string;
  requiresLogin?: boolean;
  topPatterns: string[];    // top 3 pattern descriptions for quick preview
  lastUsedAt: number;
  updatedAt: number;
}

/** Full index structure — index.json */
export interface CardIndex {
  entries: Record<string, CardIndexEntry>;
  updatedAt: number;
}
