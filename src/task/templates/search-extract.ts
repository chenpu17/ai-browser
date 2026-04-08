import type { ToolContext } from '../tool-context.js';
import type { CancelToken } from '../cancel-token.js';
import * as actions from '../tool-actions.js';
import { ErrorCode } from '../error-codes.js';
import {
  type TemplateExtractOptions,
  type TemplateLocator,
  type TemplateWaitCondition,
  extractCurrentPage,
  resolveTemplateElementId,
  waitForTemplateCondition,
} from './shared.js';

export interface SearchExtractInputs {
  startUrl: string;
  query: string;
  searchField: TemplateLocator;
  submit?: TemplateLocator;
  openResult?: TemplateLocator;
  waitForResults?: TemplateWaitCondition;
  extract?: TemplateExtractOptions;
}

export interface SearchExtractResult {
  success: boolean;
  finalPage: { url: string; title: string };
  query: string;
  resultOpened: boolean;
  pageInfo?: unknown;
  content?: unknown;
}

function makeError(message: string, code: ErrorCode): Error {
  const err = new Error(message);
  (err as any).errorCode = code;
  return err;
}

export async function executeSearchExtract(
  ctx: ToolContext,
  sessionId: string,
  inputs: SearchExtractInputs,
  token: CancelToken,
  onProgress?: (done: number) => void,
): Promise<SearchExtractResult> {
  const tabId = ctx.getActiveTab(sessionId).id;
  let stepsDone = 0;
  const progress = () => {
    stepsDone += 1;
    onProgress?.(stepsDone);
  };

  token.throwIfCanceled();
  await actions.navigate(ctx, sessionId, inputs.startUrl);
  await actions.waitForStable(ctx, sessionId, tabId, { timeout: 10_000 });
  progress();

  token.throwIfCanceled();
  const searchFieldId = await resolveTemplateElementId(
    ctx,
    sessionId,
    tabId,
    inputs.searchField,
    ErrorCode.ELEMENT_NOT_FOUND,
  );
  await actions.typeText(ctx, sessionId, tabId, searchFieldId, inputs.query);
  progress();

  token.throwIfCanceled();
  if (inputs.submit) {
    const submitId = await resolveTemplateElementId(ctx, sessionId, tabId, inputs.submit, ErrorCode.ELEMENT_NOT_FOUND);
    await actions.click(ctx, sessionId, tabId, submitId);
  } else {
    await actions.pressKey(ctx, sessionId, tabId, 'Enter');
  }
  const resultsReady = await waitForTemplateCondition(ctx, sessionId, tabId, token, inputs.waitForResults);
  if (!resultsReady) {
    throw makeError('Search results did not become ready within timeout', ErrorCode.NAVIGATION_TIMEOUT);
  }
  progress();

  let resultOpened = false;
  if (inputs.openResult) {
    token.throwIfCanceled();
    const resultId = await resolveTemplateElementId(ctx, sessionId, tabId, inputs.openResult, ErrorCode.ELEMENT_NOT_FOUND);
    await actions.click(ctx, sessionId, tabId, resultId);
    await actions.waitForStable(ctx, sessionId, tabId, { timeout: 10_000 });
    resultOpened = true;
  }
  progress();

  token.throwIfCanceled();
  const extracted = await extractCurrentPage(ctx, sessionId, tabId, inputs.extract);
  progress();

  return {
    success: true,
    finalPage: extracted.page,
    query: inputs.query,
    resultOpened,
    pageInfo: extracted.pageInfo,
    content: extracted.content,
  };
}
