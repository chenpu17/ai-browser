import type { ToolContext } from '../tool-context.js';
import type { CancelToken } from '../cancel-token.js';
import * as actions from '../tool-actions.js';
import { ErrorCode } from '../error-codes.js';

export interface TemplateLocator {
  mode: 'selector' | 'semantic';
  selector?: string;
  query?: string;
}

export interface TemplateWaitCondition {
  type: 'selector' | 'urlContains' | 'stable' | 'textIncludes';
  value?: string;
  timeoutMs?: number;
}

export interface TemplateExtractOptions {
  pageInfo?: boolean;
  content?: boolean;
  maxElements?: number;
  maxContentLength?: number;
}

function makeError(message: string, code: ErrorCode): Error {
  const err = new Error(message);
  (err as any).errorCode = code;
  return err;
}

export async function resolveTemplateElementId(
  ctx: ToolContext,
  sessionId: string,
  tabId: string,
  locator: TemplateLocator,
  missingCode = ErrorCode.ELEMENT_NOT_FOUND,
): Promise<string> {
  if (locator.mode === 'selector') {
    if (!locator.selector) {
      throw makeError('selector is required in selector mode', ErrorCode.INVALID_PARAMETER);
    }
    const tab = ctx.getTab(sessionId, tabId);
    if (!tab) {
      throw makeError(`Tab not found: ${tabId}`, ErrorCode.SESSION_NOT_FOUND);
    }

    await actions.getPageInfo(ctx, sessionId, tabId, {
      maxElements: 200,
      visibleOnly: false,
    });

    try {
      const semanticId = await tab.page.$eval(locator.selector, (el) => {
        const element = el as HTMLElement;
        const existing = element.getAttribute('data-semantic-id');
        if (existing) return existing;
        const generated = `manual_${Math.random().toString(36).slice(2, 10)}`;
        element.setAttribute('data-semantic-id', generated);
        return generated;
      });
      if (!semanticId) {
        throw makeError(`Field found but missing semantic id: ${locator.selector}`, missingCode);
      }
      return semanticId;
    } catch (err: any) {
      if ((err as any).errorCode) throw err;
      const message = String(err?.message || '');
      if (message.includes('is not a valid selector')) {
        throw makeError(`Invalid selector: ${locator.selector}`, ErrorCode.INVALID_PARAMETER);
      }
      throw makeError(`Field not found for selector: ${locator.selector}`, missingCode);
    }
  }

  if (!locator.query) {
    throw makeError('query is required in semantic mode', ErrorCode.INVALID_PARAMETER);
  }
  const result = await actions.findElement(ctx, sessionId, tabId, locator.query, 1);
  if (result.candidates.length === 0) {
    throw makeError(`Field not found for query: ${locator.query}`, missingCode);
  }
  return result.candidates[0].id;
}

export async function waitForTemplateCondition(
  ctx: ToolContext,
  sessionId: string,
  tabId: string,
  token: CancelToken | undefined,
  waitFor?: TemplateWaitCondition,
): Promise<boolean> {
  const condition = waitFor ?? { type: 'stable' };
  const timeoutMs = condition.timeoutMs ?? 10_000;
  const tab = ctx.getTab(sessionId, tabId);
  if (!tab) {
    throw makeError(`Tab not found: ${tabId}`, ErrorCode.SESSION_NOT_FOUND);
  }

  if (condition.type === 'selector') {
    if (!condition.value) {
      throw makeError('waitFor.value is required for selector', ErrorCode.INVALID_PARAMETER);
    }
    await actions.wait(ctx, sessionId, tabId, {
      condition: 'selector',
      selector: condition.value,
      milliseconds: timeoutMs,
    });
    return true;
  }

  if (condition.type === 'urlContains') {
    if (!condition.value) {
      throw makeError('waitFor.value is required for urlContains', ErrorCode.INVALID_PARAMETER);
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      token?.throwIfCanceled();
      if (tab.page.url().includes(condition.value)) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  if (condition.type === 'textIncludes') {
    if (!condition.value) {
      throw makeError('waitFor.value is required for textIncludes', ErrorCode.INVALID_PARAMETER);
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      token?.throwIfCanceled();
      const bodyText = await tab.page.evaluate(() => document.body.innerText || '');
      if (bodyText.includes(condition.value!)) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  const stability = await actions.waitForStable(ctx, sessionId, tabId, { timeout: timeoutMs });
  return stability.stable;
}

export async function extractCurrentPage(
  ctx: ToolContext,
  sessionId: string,
  tabId: string,
  extract?: TemplateExtractOptions,
): Promise<{
  page: { url: string; title: string };
  pageInfo?: unknown;
  content?: unknown;
}> {
  const pageInfoEnabled = extract?.pageInfo ?? true;
  const contentEnabled = extract?.content ?? true;
  const pageInfo = pageInfoEnabled
    ? await actions.getPageInfo(ctx, sessionId, tabId, {
        maxElements: extract?.maxElements ?? 50,
        visibleOnly: false,
      })
    : undefined;
  const content = contentEnabled
    ? await actions.getPageContent(ctx, sessionId, tabId, {
        maxLength: extract?.maxContentLength ?? 4000,
      })
    : undefined;

  const pageUrl = (pageInfo as any)?.page?.url
    ?? (ctx.getTab(sessionId, tabId)?.page.url() || '');
  const title = (pageInfo as any)?.page?.title
    ?? (ctx.getTab(sessionId, tabId)?.page.title ? await ctx.getTab(sessionId, tabId)!.page.title() : '');

  return {
    page: { url: pageUrl, title },
    pageInfo,
    content,
  };
}
