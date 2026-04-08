import type { ToolContext } from '../tool-context.js';
import type { CancelToken } from '../cancel-token.js';
import * as actions from '../tool-actions.js';
import type { TemplateExtractOptions, TemplateLocator, TemplateWaitCondition } from './shared.js';
import {
  extractCurrentPage,
  resolveTemplateElementId,
  waitForTemplateCondition,
} from './shared.js';

export interface PaginatedExtractInputs {
  startUrl: string;
  pagination: {
    next: TemplateLocator;
    maxPages: number;
    waitFor?: TemplateWaitCondition;
  };
  extract?: TemplateExtractOptions;
}

export interface PaginatedExtractPage {
  pageNumber: number;
  page: { url: string; title: string };
  pageInfo?: unknown;
  content?: unknown;
}

export interface PaginatedExtractResult {
  success: boolean;
  summary: { totalPages: number; extractedPages: number };
  pages: PaginatedExtractPage[];
  stoppedReason: 'max_pages' | 'repeated_page' | 'next_unavailable';
}

export async function executePaginatedExtract(
  ctx: ToolContext,
  sessionId: string,
  inputs: PaginatedExtractInputs,
  token: CancelToken,
  onProgress?: (done: number) => void,
): Promise<PaginatedExtractResult> {
  const tabId = ctx.getActiveTab(sessionId).id;
  const pages: PaginatedExtractPage[] = [];
  const seenUrls = new Set<string>();
  let done = 0;
  const progress = () => {
    done += 1;
    onProgress?.(done);
  };

  token.throwIfCanceled();
  await actions.navigate(ctx, sessionId, inputs.startUrl);
  await actions.waitForStable(ctx, sessionId, tabId, { timeout: 10_000 });

  let stoppedReason: PaginatedExtractResult['stoppedReason'] = 'max_pages';

  for (let pageNumber = 1; pageNumber <= inputs.pagination.maxPages; pageNumber++) {
    token.throwIfCanceled();
    const extracted = await extractCurrentPage(ctx, sessionId, tabId, inputs.extract);
    pages.push({
      pageNumber,
      page: extracted.page,
      pageInfo: extracted.pageInfo,
      content: extracted.content,
    });
    progress();

    if (pageNumber === inputs.pagination.maxPages) {
      stoppedReason = 'max_pages';
      break;
    }

    if (seenUrls.has(extracted.page.url)) {
      stoppedReason = 'repeated_page';
      break;
    }
    seenUrls.add(extracted.page.url);

    try {
      const nextId = await resolveTemplateElementId(ctx, sessionId, tabId, inputs.pagination.next);
      await actions.click(ctx, sessionId, tabId, nextId);
      const ready = await waitForTemplateCondition(ctx, sessionId, tabId, token, inputs.pagination.waitFor);
      if (!ready) {
        stoppedReason = 'next_unavailable';
        break;
      }
    } catch {
      stoppedReason = 'next_unavailable';
      break;
    }
  }

  return {
    success: true,
    summary: {
      totalPages: inputs.pagination.maxPages,
      extractedPages: pages.length,
    },
    pages,
    stoppedReason,
  };
}
