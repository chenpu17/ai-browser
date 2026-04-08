import type { ToolContext } from '../tool-context.js';
import type { CancelToken } from '../cancel-token.js';
import * as actions from '../tool-actions.js';
import type { TemplateExtractOptions, TemplateLocator, TemplateWaitCondition } from './shared.js';
import {
  extractCurrentPage,
  resolveTemplateElementId,
  waitForTemplateCondition,
} from './shared.js';

export interface SubmitAndVerifyInputs {
  startUrl: string;
  fields: Array<{
    name: string;
    value: string;
    locator: TemplateLocator;
  }>;
  submit?: TemplateLocator;
  successIndicator?: TemplateWaitCondition;
  extract?: TemplateExtractOptions;
}

export interface SubmitAndVerifyResult {
  success: boolean;
  finalPage: { url: string; title: string };
  submittedFields: string[];
  indicatorMatched: boolean;
  pageInfo?: unknown;
  content?: unknown;
  error?: string;
}

export async function executeSubmitAndVerify(
  ctx: ToolContext,
  sessionId: string,
  inputs: SubmitAndVerifyInputs,
  token: CancelToken,
  onProgress?: (done: number) => void,
): Promise<SubmitAndVerifyResult> {
  const tabId = ctx.getActiveTab(sessionId).id;
  let done = 0;
  const progress = () => {
    done += 1;
    onProgress?.(done);
  };

  token.throwIfCanceled();
  await actions.navigate(ctx, sessionId, inputs.startUrl);
  await actions.waitForStable(ctx, sessionId, tabId, { timeout: 10_000 });
  progress();

  const submittedFields: string[] = [];
  for (const field of inputs.fields) {
    token.throwIfCanceled();
    const fieldId = await resolveTemplateElementId(ctx, sessionId, tabId, field.locator);
    await actions.typeText(ctx, sessionId, tabId, fieldId, field.value);
    submittedFields.push(field.name);
  }
  progress();

  token.throwIfCanceled();
  if (inputs.submit) {
    const submitId = await resolveTemplateElementId(ctx, sessionId, tabId, inputs.submit);
    await actions.click(ctx, sessionId, tabId, submitId);
  } else {
    await actions.pressKey(ctx, sessionId, tabId, 'Enter');
  }
  progress();

  token.throwIfCanceled();
  const indicatorMatched = await waitForTemplateCondition(
    ctx,
    sessionId,
    tabId,
    token,
    inputs.successIndicator,
  );
  progress();

  const extracted = await extractCurrentPage(ctx, sessionId, tabId, inputs.extract);
  progress();

  return {
    success: indicatorMatched,
    finalPage: extracted.page,
    submittedFields,
    indicatorMatched,
    pageInfo: extracted.pageInfo,
    content: extracted.content,
    error: indicatorMatched ? undefined : 'Success indicator not reached within timeout',
  };
}
