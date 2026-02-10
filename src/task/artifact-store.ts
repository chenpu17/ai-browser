import { randomUUID } from 'node:crypto';

export interface ArtifactMeta {
  artifactId: string;
  runId: string;
  mimeType: string;
  size: number;
  createdAt: number;
}

export interface ArtifactChunk {
  artifactId: string;
  mimeType: string;
  totalSize: number;
  offset: number;
  length: number;
  data: string; // base64 for binary, raw for text
  complete: boolean;
}


const MAX_CHUNK_SIZE = 256 * 1024; // 256KB per read
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class ArtifactStore {
  private artifacts = new Map<string, { meta: ArtifactMeta; data: Buffer }>();
  private runIndex = new Map<string, Set<string>>();
  private expirations = new Map<string, number>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  save(runId: string, data: Buffer | string, mimeType: string): string {
    const artifactId = randomUUID();
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    const meta: ArtifactMeta = {
      artifactId,
      runId,
      mimeType,
      size: buf.length,
      createdAt: Date.now(),
    };

    this.artifacts.set(artifactId, { meta, data: buf });

    // Update run index
    let ids = this.runIndex.get(runId);
    if (!ids) {
      ids = new Set();
      this.runIndex.set(runId, ids);
    }
    ids.add(artifactId);

    return artifactId;
  }

  get(artifactId: string, offset?: number, limit?: number): ArtifactChunk | undefined {
    const entry = this.artifacts.get(artifactId);
    if (!entry) return undefined;

    const { meta, data } = entry;
    const start = Math.min(offset ?? 0, data.length);
    const maxLen = Math.min(limit ?? MAX_CHUNK_SIZE, MAX_CHUNK_SIZE);
    const end = Math.min(start + maxLen, data.length);
    const slice = data.subarray(start, end);

    const isText = meta.mimeType.startsWith('text/') ||
      meta.mimeType === 'application/json';

    return {
      artifactId,
      mimeType: meta.mimeType,
      totalSize: meta.size,
      offset: start,
      length: slice.length,
      data: isText ? slice.toString('utf-8') : slice.toString('base64'),
      complete: end >= data.length,
    };
  }

  getMeta(artifactId: string): ArtifactMeta | undefined {
    return this.artifacts.get(artifactId)?.meta;
  }

  listByRun(runId: string): ArtifactMeta[] {
    const ids = this.runIndex.get(runId);
    if (!ids) return [];
    const result: ArtifactMeta[] = [];
    for (const id of ids) {
      const entry = this.artifacts.get(id);
      if (entry) result.push(entry.meta);
    }
    return result;
  }

  /**
   * Mark artifacts for a run as expiring.
   * Called when the associated run reaches a terminal state.
   */
  markExpiring(runId: string): void {
    const ids = this.runIndex.get(runId);
    if (!ids) return;
    const expireAt = Date.now() + this.ttlMs;
    for (const id of ids) {
      this.expirations.set(id, expireAt);
    }
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.artifacts.clear();
    this.runIndex.clear();
    this.expirations.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, expireAt] of this.expirations) {
      if (now >= expireAt) {
        const entry = this.artifacts.get(id);
        if (entry) {
          const runIds = this.runIndex.get(entry.meta.runId);
          if (runIds) {
            runIds.delete(id);
            if (runIds.size === 0) {
              this.runIndex.delete(entry.meta.runId);
            }
          }
        }
        this.artifacts.delete(id);
        this.expirations.delete(id);
      }
    }
  }
}
