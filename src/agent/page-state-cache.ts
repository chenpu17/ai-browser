/**
 * Caches page element state per session to compute diffs between get_page_info calls.
 * When the page hasn't changed much, returns only added/removed/changed elements.
 */

export interface PageDiff {
  isNewPage: boolean;
  added: any[];
  removed: string[];
  changed: any[];
  unchangedCount: number;
}

interface PageSnapshot {
  url: string;
  elementMap: Map<string, any>;
}

const FULL_REFRESH_THRESHOLD = 0.5; // >50% change → return full list

export class PageStateCache {
  private snapshots = new Map<string, PageSnapshot>();

  /**
   * Update cache and compute diff for a session.
   * Returns null if this is the first call or a new page (caller should use full list).
   */
  update(sessionId: string, elements: any[], url: string): PageDiff {
    const prev = this.snapshots.get(sessionId);
    const currentMap = new Map<string, any>();
    for (const el of elements) {
      if (el?.id) currentMap.set(el.id, el);
    }

    // Store new snapshot
    this.snapshots.set(sessionId, { url, elementMap: currentMap });

    // No previous snapshot → new page
    if (!prev) {
      return { isNewPage: true, added: elements, removed: [], changed: [], unchangedCount: 0 };
    }

    // URL changed → new page
    if (prev.url !== url) {
      return { isNewPage: true, added: elements, removed: [], changed: [], unchangedCount: 0 };
    }

    // Compute diff
    const added: any[] = [];
    const changed: any[] = [];
    const removed: string[] = [];
    let unchangedCount = 0;

    // Find added and changed
    for (const [id, el] of currentMap) {
      const prevEl = prev.elementMap.get(id);
      if (!prevEl) {
        added.push(el);
      } else if (this.hasChanged(prevEl, el)) {
        changed.push(el);
      } else {
        unchangedCount++;
      }
    }

    // Find removed
    for (const id of prev.elementMap.keys()) {
      if (!currentMap.has(id)) {
        removed.push(id);
      }
    }

    // If too many changes, treat as new page
    const totalPrev = prev.elementMap.size;
    const changedCount = added.length + removed.length + changed.length;
    if (totalPrev > 0 && changedCount / totalPrev > FULL_REFRESH_THRESHOLD) {
      return { isNewPage: true, added: elements, removed: [], changed: [], unchangedCount: 0 };
    }

    return { isNewPage: false, added, removed, changed, unchangedCount };
  }

  clear(sessionId: string): void {
    this.snapshots.delete(sessionId);
  }

  private hasChanged(prev: any, curr: any): boolean {
    // Compare key properties that matter for interaction
    return (
      prev.label !== curr.label ||
      prev.type !== curr.type ||
      JSON.stringify(prev.state) !== JSON.stringify(curr.state)
    );
  }
}
