import type { ToolContext } from '../tool-context.js';
import type { CancelToken } from '../cancel-token.js';
import * as actions from '../tool-actions.js';
import { safePageTitle } from '../../utils/safe-page.js';
import { ErrorCode } from '../error-codes.js';

// ===== Input / Output types =====

export interface LoginKeepSessionInputs {
  startUrl: string;
  credentials: {
    username: string;
    password: string;
  };
  fields: {
    mode: 'selector' | 'semantic';
    usernameSelector?: string;
    passwordSelector?: string;
    submitSelector?: string;
    usernameQuery?: string;
    passwordQuery?: string;
    submitQuery?: string;
  };
  successIndicator?: {
    type: 'selector' | 'urlContains' | 'stable';
    value?: string;
  };
}

export interface LoginKeepSessionResult {
  success: boolean;
  sessionId: string;
  finalUrl: string;
  title: string;
  loginState: 'authenticated' | 'unknown';
  cookiesSaved: boolean;
  error?: string;
}

export const LOGIN_TOTAL_STEPS = 5;

function makeError(message: string, code: ErrorCode): Error {
  const err = new Error(message);
  (err as any).errorCode = code;
  return err;
}

function isTimeoutError(err: unknown): boolean {
  const message = String((err as any)?.message ?? '').toLowerCase();
  return message.includes('timeout') || (err as any)?.name === 'TimeoutError';
}

/** Resolve element ID via selector or semantic search */
async function resolveElementId(
  ctx: ToolContext,
  sessionId: string,
  tabId: string,
  mode: 'selector' | 'semantic',
  selector?: string,
  query?: string,
): Promise<string> {
  if (mode === 'selector') {
    if (!selector) {
      throw makeError('selector is required in selector mode', ErrorCode.INVALID_PARAMETER);
    }

    const tab = ctx.getTab(sessionId, tabId);
    if (!tab) {
      throw makeError(`Tab not found: ${tabId}`, ErrorCode.SESSION_NOT_FOUND);
    }

    // Ensure semantic IDs are injected before reading data-semantic-id from DOM.
    await actions.getPageInfo(ctx, sessionId, tabId, {
      maxElements: 200,
      visibleOnly: false,
    });

    try {
      const semanticId = await tab.page.$eval(selector, (el) => {
        return (el as any).getAttribute('data-semantic-id') || '';
      });
      if (semanticId) {
        return semanticId;
      }
      throw makeError(
        `Field found but missing semantic id: ${selector}`,
        ErrorCode.TPL_LOGIN_FIELD_NOT_FOUND,
      );
    } catch (err: any) {
      const msg = String(err?.message || '');
      if (msg.includes('Failed to execute') || msg.includes('is not a valid selector')) {
        throw makeError(`Invalid selector: ${selector}`, ErrorCode.INVALID_PARAMETER);
      }
      if ((err as any).errorCode) {
        throw err;
      }
      throw makeError(
        `Field not found for selector: ${selector}`,
        ErrorCode.TPL_LOGIN_FIELD_NOT_FOUND,
      );
    }
  }

  if (!query) {
    throw makeError('query is required in semantic mode', ErrorCode.INVALID_PARAMETER);
  }
  const result = await actions.findElement(ctx, sessionId, tabId, query, 1);
  if (result.candidates.length === 0) {
    throw makeError(
      `Field not found for query: ${query}`,
      ErrorCode.TPL_LOGIN_FIELD_NOT_FOUND,
    );
  }
  return result.candidates[0].id;
}

async function waitForSuccessIndicator(
  ctx: ToolContext,
  sessionId: string,
  tabId: string,
  token: CancelToken,
  successIndicator?: LoginKeepSessionInputs['successIndicator'],
): Promise<boolean> {
  const indicator = successIndicator ?? { type: 'stable' as const };

  if (indicator.type === 'selector') {
    if (!indicator.value) {
      throw makeError('successIndicator.value is required for selector mode', ErrorCode.INVALID_PARAMETER);
    }
    try {
      await actions.wait(ctx, sessionId, tabId, {
        condition: 'selector',
        selector: indicator.value,
        milliseconds: 10000,
      });
      return true;
    } catch (err) {
      if (isTimeoutError(err)) return false;
      throw err;
    }
  }

  if (indicator.type === 'urlContains') {
    if (!indicator.value) {
      throw makeError('successIndicator.value is required for urlContains mode', ErrorCode.INVALID_PARAMETER);
    }

    const deadline = Date.now() + 10000;
    const tab = ctx.getTab(sessionId, tabId);
    while (Date.now() < deadline) {
      token.throwIfCanceled();
      if (tab && tab.page.url().includes(indicator.value)) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  try {
    const stability = await actions.waitForStable(ctx, sessionId, tabId, { timeout: 10000 });
    return stability.stable;
  } catch (err) {
    if (isTimeoutError(err)) return false;
    throw err;
  }
}

// ===== Main executor =====

export async function executeLoginKeepSession(
  ctx: ToolContext,
  sessionId: string,
  inputs: LoginKeepSessionInputs,
  token: CancelToken,
  onProgress?: (done: number) => void,
): Promise<LoginKeepSessionResult> {
  const { startUrl, credentials, fields, successIndicator } = inputs;
  const tabId = ctx.getActiveTab(sessionId).id;
  let stepsDone = 0;
  const progress = () => {
    stepsDone++;
    onProgress?.(stepsDone);
  };

  // Step 1: Navigate to login page
  token.throwIfCanceled();
  await actions.navigate(ctx, sessionId, startUrl);
  await actions.waitForStable(ctx, sessionId, tabId, { timeout: 5000 });
  progress();

  // Step 2: Locate fields
  token.throwIfCanceled();
  const usernameId = await resolveElementId(
    ctx,
    sessionId,
    tabId,
    fields.mode,
    fields.usernameSelector,
    fields.usernameQuery,
  );
  const passwordId = await resolveElementId(
    ctx,
    sessionId,
    tabId,
    fields.mode,
    fields.passwordSelector,
    fields.passwordQuery,
  );
  progress();

  // Step 3: Type credentials (with retry)
  token.throwIfCanceled();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await actions.typeText(ctx, sessionId, tabId, usernameId, credentials.username);
      await actions.typeText(ctx, sessionId, tabId, passwordId, credentials.password);
      break;
    } catch (err: any) {
      if (attempt === 0) continue;
      throw err;
    }
  }
  progress();

  // Step 4: Submit (click button or press Enter)
  token.throwIfCanceled();
  if (fields.mode === 'selector' && fields.submitSelector) {
    const submitId = await resolveElementId(ctx, sessionId, tabId, 'selector', fields.submitSelector);
    await actions.click(ctx, sessionId, tabId, submitId);
  } else if (fields.mode === 'semantic' && fields.submitQuery) {
    const submitId = await resolveElementId(ctx, sessionId, tabId, 'semantic', undefined, fields.submitQuery);
    await actions.click(ctx, sessionId, tabId, submitId);
  } else {
    await actions.pressKey(ctx, sessionId, tabId, 'Enter');
  }
  progress();

  // Step 5: Wait for success indicator and verify it was met
  token.throwIfCanceled();
  const indicatorMatched = await waitForSuccessIndicator(ctx, sessionId, tabId, token, successIndicator);
  progress();

  // Save cookies
  const tab = ctx.getTab(sessionId, tabId);
  let cookiesSaved = false;
  if (tab) {
    try {
      await ctx.saveCookies(tab.page);
      cookiesSaved = true;
    } catch {}
  }

  const finalUrl = tab?.page.url() ?? '';
  let title = '';
  title = tab ? await safePageTitle(tab.page) : '';

  if (!indicatorMatched) {
    return {
      success: false,
      sessionId,
      finalUrl,
      title,
      loginState: 'unknown',
      cookiesSaved,
      error: 'Success indicator not reached within timeout',
    };
  }

  return {
    success: true,
    sessionId,
    finalUrl,
    title,
    loginState: 'authenticated',
    cookiesSaved,
  };
}
