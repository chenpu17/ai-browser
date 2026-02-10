import type { ToolContext } from '../tool-context.js';
import type { CancelToken } from '../cancel-token.js';
import * as actions from '../tool-actions.js';
import { ErrorCode } from '../error-codes.js';
import { validateUrlAsync } from '../../utils/url-validator.js';

// ===== Input / Output types =====

export interface MultiTabCompareInputs {
  urls: string[];
  extract?: {
    pageInfo?: boolean;
    content?: boolean;
    maxElements?: number;
    maxContentLength?: number;
  };
  compare?: {
    fields?: Array<'title' | 'elementCount' | 'topSections'>;
    topSections?: number;
    numericTolerance?: number;
  };
  concurrency?: number;
}

export interface TabSnapshot {
  url: string;
  title: string;
  elementCount: number;
  topSections: string[];
  success: boolean;
  error?: string;
}

export interface DiffItem {
  field: string;
  same: boolean;
  values: Record<string, string | number | string[]>;
  delta?: number;
  changedPositions?: number[];
}

export interface MultiTabCompareResult {
  summary: { total: number; succeeded: number; failed: number };
  snapshots: TabSnapshot[];
  diffs: DiffItem[];
}

const MAX_URLS = 10;
const MAX_CONCURRENCY = 5;

async function slidingWindow<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers: Promise<void>[] = [];

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      await fn(items[i], i);
    }
  }

  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

/** Extract a snapshot from a single tab */
async function extractSnapshot(
  ctx: ToolContext,
  sessionId: string,
  url: string,
  opts: {
    pageInfo: boolean;
    content: boolean;
    maxElements: number;
    maxContentLength: number;
    topSections: number;
  },
  token?: CancelToken,
): Promise<TabSnapshot> {
  if (token?.canceled) {
    return {
      url,
      title: '',
      elementCount: 0,
      topSections: [],
      success: false,
      error: 'Canceled',
    };
  }

  let tabId: string | undefined;
  try {
    const tab = await actions.createTab(ctx, sessionId, url);
    tabId = tab.tabId;
    await actions.waitForStable(ctx, sessionId, tabId, { timeout: 10000 });

    let title = '';
    let elementCount = 0;
    let topSections: string[] = [];

    if (opts.pageInfo) {
      const info = await actions.getPageInfo(ctx, sessionId, tabId, {
        maxElements: opts.maxElements,
        visibleOnly: false,
      });
      title = info.page.title;
      elementCount = info.totalElements;
    }

    if (opts.content) {
      const content = await actions.getPageContent(ctx, sessionId, tabId, {
        maxLength: opts.maxContentLength,
      });
      topSections = (content.sections || [])
        .slice(0, opts.topSections)
        .map((s: any) => s.heading || s.text?.slice(0, 80) || '')
        .filter(Boolean);
    }

    await actions.closeTab(ctx, sessionId, tabId).catch(() => {});

    return {
      url,
      title,
      elementCount,
      topSections,
      success: true,
    };
  } catch (err: any) {
    if (tabId) {
      await actions.closeTab(ctx, sessionId, tabId).catch(() => {});
    }
    return {
      url,
      title: '',
      elementCount: 0,
      topSections: [],
      success: false,
      error: err.message || 'Unknown error',
    };
  }
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Compute diffs across successful snapshots */
function computeDiffs(
  snapshots: TabSnapshot[],
  compare?: MultiTabCompareInputs['compare'],
): DiffItem[] {
  const successful = snapshots.filter((s) => s.success);
  if (successful.length < 2) return [];

  const fields = compare?.fields ?? ['title', 'elementCount', 'topSections'];
  const numericTolerance = compare?.numericTolerance ?? 0;
  const topN = compare?.topSections ?? 3;

  const baseline = successful[0];
  const diffs: DiffItem[] = [];

  if (fields.includes('title')) {
    const values = Object.fromEntries(successful.map((s) => [s.url, s.title]));
    const same = successful.every((s) => normalizeText(s.title) === normalizeText(baseline.title));
    if (!same) {
      diffs.push({ field: 'title', same: false, values });
    }
  }

  if (fields.includes('elementCount')) {
    const values = Object.fromEntries(successful.map((s) => [s.url, s.elementCount]));
    const min = Math.min(...successful.map((s) => s.elementCount));
    const max = Math.max(...successful.map((s) => s.elementCount));
    const delta = max - min;
    if (delta > numericTolerance) {
      diffs.push({ field: 'elementCount', same: false, values, delta });
    }
  }

  if (fields.includes('topSections')) {
    const values = Object.fromEntries(
      successful.map((s) => [s.url, s.topSections.slice(0, topN)]),
    );
    const changedPositions = new Set<number>();

    for (let i = 0; i < topN; i++) {
      const baseText = normalizeText(baseline.topSections[i] ?? '');
      for (let j = 1; j < successful.length; j++) {
        const otherText = normalizeText(successful[j].topSections[i] ?? '');
        if (baseText !== otherText) {
          changedPositions.add(i + 1);
          break;
        }
      }
    }

    if (changedPositions.size > 0) {
      diffs.push({
        field: 'topSections',
        same: false,
        values,
        changedPositions: Array.from(changedPositions),
      });
    }
  }

  return diffs;
}

// ===== Main executor =====

export async function executeMultiTabCompare(
  ctx: ToolContext,
  sessionId: string,
  inputs: MultiTabCompareInputs,
  token: CancelToken,
  onProgress?: (done: number) => void,
): Promise<MultiTabCompareResult> {
  const urls = inputs.urls;
  if (!urls || urls.length === 0) {
    return { summary: { total: 0, succeeded: 0, failed: 0 }, snapshots: [], diffs: [] };
  }
  if (urls.length > MAX_URLS) {
    const err = new Error(`Too many URLs: ${urls.length}, max ${MAX_URLS}`);
    (err as any).errorCode = ErrorCode.INVALID_PARAMETER;
    throw err;
  }

  const opts = {
    pageInfo: inputs.extract?.pageInfo ?? true,
    content: inputs.extract?.content ?? true,
    maxElements: inputs.extract?.maxElements ?? 50,
    maxContentLength: inputs.extract?.maxContentLength ?? 4000,
    topSections: inputs.compare?.topSections ?? 3,
  };

  const snapshots: TabSnapshot[] = new Array(urls.length);
  let doneCount = 0;

  const validIndices: number[] = [];
  for (let i = 0; i < urls.length; i++) {
    if (token.canceled) {
      snapshots[i] = { url: urls[i], title: '', elementCount: 0, topSections: [], success: false, error: 'Canceled' };
      doneCount++;
      onProgress?.(doneCount);
      continue;
    }

    const check = await validateUrlAsync(urls[i], ctx.urlOpts);
    if (check.valid) {
      validIndices.push(i);
    } else {
      snapshots[i] = { url: urls[i], title: '', elementCount: 0, topSections: [], success: false, error: check.reason };
      doneCount++;
      onProgress?.(doneCount);
    }
  }

  const concurrency = Math.min(
    inputs.concurrency ?? 3,
    MAX_CONCURRENCY,
    Math.max(validIndices.length, 1),
  );

  await slidingWindow(validIndices, concurrency, async (urlIndex) => {
    if (token.canceled) {
      return;
    }
    snapshots[urlIndex] = await extractSnapshot(ctx, sessionId, urls[urlIndex], opts, token);
    doneCount++;
    onProgress?.(doneCount);
  });

  for (let i = 0; i < urls.length; i++) {
    if (!snapshots[i]) {
      snapshots[i] = { url: urls[i], title: '', elementCount: 0, topSections: [], success: false, error: 'Canceled' };
      doneCount++;
      onProgress?.(doneCount);
    }
  }

  const diffs = computeDiffs(snapshots, inputs.compare);
  doneCount++;
  onProgress?.(doneCount);

  let succeeded = 0;
  let failed = 0;
  for (const s of snapshots) {
    if (s.success) succeeded++;
    else failed++;
  }

  return {
    summary: { total: urls.length, succeeded, failed },
    snapshots,
    diffs,
  };
}
