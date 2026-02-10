import type { ToolContext } from '../tool-context.js';
import type { CancelToken } from '../cancel-token.js';
import * as actions from '../tool-actions.js';
import { validateUrlAsync } from '../../utils/url-validator.js';

// ===== Input / Output types =====

export interface BatchExtractInputs {
  urls: string[];
  extract?: {
    pageInfo?: boolean;
    content?: boolean;
    maxElements?: number;
    maxContentLength?: number;
  };
  concurrency?: number;
}

export interface BatchExtractItem {
  url: string;
  title?: string;
  pageType?: string;
  elementCount?: number;
  contentSections?: number;
  content?: any;
  pageInfo?: any;
  success: boolean;
  error?: string;
}

export interface BatchExtractResult {
  summary: { total: number; succeeded: number; failed: number };
  items: BatchExtractItem[];
}

// Max concurrency cap
const MAX_CONCURRENCY = 5;

// Errors worth retrying
const RETRYABLE_ERRORS = ['NAVIGATION_TIMEOUT', 'PAGE_CRASHED'];

// ===== Sliding window concurrency =====

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

// ===== Single URL extraction =====

interface ExtractOpts {
  pageInfo: boolean;
  content: boolean;
  maxElements: number;
  maxContentLength: number;
}

async function extractSingleUrl(
  ctx: ToolContext,
  sessionId: string,
  url: string,
  opts: ExtractOpts,
  token?: CancelToken,
): Promise<BatchExtractItem> {
  let lastError: string | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (token?.canceled) {
      return { url, success: false, error: 'Canceled' };
    }

    let tabId: string | undefined;
    try {
      const tab = await actions.createTab(ctx, sessionId, url);
      tabId = tab.tabId;

      if (token?.canceled) {
        await actions.closeTab(ctx, sessionId, tabId).catch(() => {});
        return { url, success: false, error: 'Canceled' };
      }

      // Wait for DOM stability
      await actions.waitForStable(ctx, sessionId, tabId, { timeout: 10000 });

      const item: BatchExtractItem = { url, success: true };

      // Extract page info
      if (opts.pageInfo) {
        const info = await actions.getPageInfo(ctx, sessionId, tabId, {
          maxElements: opts.maxElements,
          visibleOnly: false,
        });
        item.title = info.page.title;
        item.pageType = info.page.type;
        item.elementCount = info.totalElements;
        item.pageInfo = info;
      }

      // Extract page content
      if (opts.content) {
        const content = await actions.getPageContent(ctx, sessionId, tabId, {
          maxLength: opts.maxContentLength,
        });
        item.contentSections = content.sections?.length ?? 0;
        item.content = content;
      }

      // Close tab
      await actions.closeTab(ctx, sessionId, tabId).catch(() => {});
      return item;
    } catch (err: any) {
      const errorCode: string = err.errorCode ?? '';
      lastError = err.message || 'Unknown error';

      // Always try to close the tab
      if (tabId) {
        await actions.closeTab(ctx, sessionId, tabId).catch(() => {});
      }

      if (token?.canceled) {
        return { url, success: false, error: 'Canceled' };
      }

      // Only retry on retryable errors, and only on first attempt
      const retryable = RETRYABLE_ERRORS.includes(errorCode)
        || err.name === 'TimeoutError'
        || (lastError?.includes('timeout') ?? false);
      if (attempt === 0 && retryable) {
        continue;
      }

      return { url, success: false, error: lastError };
    }
  }

  // Should not reach here, but guard
  return { url, success: false, error: lastError ?? 'Max retries exceeded' };
}

// ===== Main executor =====

export async function executeBatchExtract(
  ctx: ToolContext,
  sessionId: string,
  inputs: BatchExtractInputs,
  onProgress?: (done: number) => void,
  token?: CancelToken,
): Promise<BatchExtractResult> {
  const urls = inputs.urls;
  if (!urls || urls.length === 0) {
    return { summary: { total: 0, succeeded: 0, failed: 0 }, items: [] };
  }

  // Resolve extract options with defaults
  const extractOpts: ExtractOpts = {
    pageInfo: inputs.extract?.pageInfo ?? true,
    content: inputs.extract?.content ?? true,
    maxElements: inputs.extract?.maxElements ?? 50,
    maxContentLength: inputs.extract?.maxContentLength ?? 4000,
  };

  // Validate all URLs upfront
  const items: BatchExtractItem[] = new Array(urls.length);
  const validIndices: number[] = [];

  for (let i = 0; i < urls.length; i++) {
    if (token?.canceled) {
      for (let j = i; j < urls.length; j++) {
        items[j] = { url: urls[j], success: false, error: 'Canceled' };
      }
      break;
    }

    const check = await validateUrlAsync(urls[i], ctx.urlOpts);
    if (check.valid) {
      validIndices.push(i);
    } else {
      items[i] = { url: urls[i], success: false, error: check.reason ?? 'Invalid URL' };
    }
  }

  // Calculate effective concurrency
  const concurrency = Math.min(
    inputs.concurrency ?? 3,
    MAX_CONCURRENCY,
    Math.max(validIndices.length, 1),
  );

  // Track progress
  let doneCount = items.filter(Boolean).length;
  if (onProgress && doneCount > 0) onProgress(doneCount);

  // Run extraction with sliding window
  await slidingWindow(validIndices, concurrency, async (urlIndex) => {
    if (token?.canceled) {
      return;
    }
    items[urlIndex] = await extractSingleUrl(ctx, sessionId, urls[urlIndex], extractOpts, token);
    doneCount++;
    onProgress?.(doneCount);
  });

  // Mark untouched entries as canceled to keep summary consistent.
  for (let i = 0; i < items.length; i++) {
    if (!items[i]) {
      items[i] = { url: urls[i], success: false, error: 'Canceled' };
      doneCount++;
      onProgress?.(doneCount);
    }
  }

  // Aggregate summary
  let succeeded = 0;
  let failed = 0;
  for (const item of items) {
    if (item.success) succeeded++;
    else failed++;
  }

  return {
    summary: { total: urls.length, succeeded, failed },
    items,
  };
}
