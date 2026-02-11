import type { ToolContext } from './tool-context.js';
import { validateUrlAsync } from '../utils/url-validator.js';
import {
  ElementCollector,
  ElementMatcher,
  PageAnalyzer,
  RegionDetector,
  ContentExtractor,
} from '../semantic/index.js';
import { executeAction } from '../browser/actions.js';
import type { KeyInput } from 'puppeteer-core';
import { ErrorCode } from './error-codes.js';

// Shared semantic module instances
const elementCollector = new ElementCollector();
const elementMatcher = new ElementMatcher();
const pageAnalyzer = new PageAnalyzer();
const regionDetector = new RegionDetector();
const contentExtractor = new ContentExtractor();

// ===== Result types =====

export interface NavigateResult {
  success: boolean;
  partial: boolean;
  statusCode?: number;
  page: { url: string; title: string };
  dialog?: any;
}

export interface StabilityResult {
  stable: boolean;
  domStable: boolean;
  networkPending: number;
  loadState: string;
}

export interface PageInfoResult {
  page: { url: string; title: string; type: string; summary: string };
  elements: any[];
  totalElements: number;
  truncated: boolean;
  regions: any[];
  intents: any[];
  recommendedByIntent?: Array<{
    intent: string;
    suggestedElementIds: string[];
  }>;
  stability?: any;
  pendingDialog?: any;
}

export interface PageContentResult {
  sections: any[];
  [key: string]: any;
}

export interface CreateTabResult {
  tabId: string;
  url: string;
  partial: boolean;
}

export interface FindElementResult {
  query: string;
  candidates: Array<{
    id: string;
    label: string;
    type: string;
    score: number;
    matchReason: string;
  }>;
}

export interface ClickResult {
  success: boolean;
  page: { url: string; title: string };
  newTabCreated?: string;
  dialog?: any;
}

export interface TypeTextResult {
  success: boolean;
  page: { url: string; title: string };
}

export interface PressKeyResult {
  success: boolean;
  page: { url: string; title: string };
}

export interface WaitResult {
  success: boolean;
}

// ===== Helper =====

function makeError(message: string, code: ErrorCode): Error {
  const err = new Error(message);
  (err as any).errorCode = code;
  return err;
}

function recommendElementsByIntent(intents: any[], elements: any[]): Array<{ intent: string; suggestedElementIds: string[] }> {
  const picks: Array<{ intent: string; suggestedElementIds: string[] }> = [];
  const scored = elements.map((el: any) => ({
    id: String(el?.id || ''),
    type: String(el?.type || ''),
    label: String(el?.label || '').toLowerCase(),
  }));

  const pick = (intent: string, keywords: string[], preferredTypes: string[] = [], limit = 3): string[] => {
    const ranked = scored
      .map((el) => {
        let score = 0;
        if (preferredTypes.includes(el.type)) score += 3;
        for (const keyword of keywords) {
          if (el.id.toLowerCase().includes(keyword)) score += 3;
          if (el.label.includes(keyword)) score += 2;
        }
        return { ...el, score };
      })
      .filter((el) => el.id && el.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((el) => el.id);
    if (ranked.length > 0) {
      picks.push({ intent, suggestedElementIds: ranked });
    }
    return ranked;
  };

  for (const intent of intents) {
    const name = String(intent?.name || '').toLowerCase();
    if (!name) continue;
    if (name === 'login') {
      pick(name, ['user', 'email', 'account', 'name'], ['textbox', 'input']);
      pick(name, ['password', 'pass'], ['textbox', 'input']);
      pick(name, ['login', 'sign in', 'submit'], ['button', 'link']);
    } else if (name === 'search') {
      pick(name, ['search', 'query', 'keyword', 'q'], ['textbox', 'input', 'searchbox']);
      pick(name, ['search', 'go', 'submit'], ['button', 'link']);
    } else if (name === 'submit_form') {
      pick(name, ['submit', 'save', 'confirm', 'continue'], ['button', 'link']);
    } else if (name === 'send_email') {
      pick(name, ['to', 'recipient'], ['textbox', 'input']);
      pick(name, ['subject'], ['textbox', 'input']);
      pick(name, ['send'], ['button', 'link']);
    } else if (name === 'select_result') {
      pick(name, ['result', 'title', 'link'], ['link', 'button']);
    } else {
      pick(name, [name], ['button', 'link', 'textbox', 'input']);
    }
  }

  const deduped = new Map<string, string[]>();
  for (const entry of picks) {
    const current = deduped.get(entry.intent) ?? [];
    for (const id of entry.suggestedElementIds) {
      if (!current.includes(id)) current.push(id);
      if (current.length >= 5) break;
    }
    deduped.set(entry.intent, current);
  }

  return [...deduped.entries()].map(([intent, suggestedElementIds]) => ({ intent, suggestedElementIds }));
}

// ===== Tool Actions =====

/** 导航到指定 URL（操作 active tab） */
export async function navigate(
  ctx: ToolContext,
  sessionId: string,
  url: string,
): Promise<NavigateResult> {
  const check = await validateUrlAsync(url, ctx.urlOpts);
  if (!check.valid) {
    throw makeError(check.reason!, ErrorCode.INVALID_PARAMETER);
  }

  const tab = ctx.getActiveTab(sessionId);
  await ctx.sessionManager.syncHeadfulCookies();
  await ctx.injectCookies(tab.page);

  let partial = false;
  let statusCode: number | undefined;
  try {
    const response = await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    statusCode = response?.status();
  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.message?.includes('timeout')) {
      partial = true;
    } else {
      throw new Error(err.message || 'Navigation failed');
    }
  }

  // SPA 额外渲染时间
  try { await tab.page.waitForNetworkIdle({ timeout: 3000 }); } catch {}

  tab.url = tab.page.url();
  await ctx.saveCookies(tab.page);
  ctx.sessionManager.updateActivity(sessionId);

  let title = '';
  try { title = await tab.page.title(); } catch { title = '(无法获取标题)'; }

  const result: NavigateResult = { success: true, partial, statusCode, page: { url: tab.page.url(), title } };
  if (tab.events) {
    const pending = tab.events.getPendingDialog();
    if (pending) (result as any).dialog = pending;
  }
  return result;
}

/** 等待页面 DOM 稳定（支持显式 tabId） */
export async function waitForStable(
  ctx: ToolContext,
  sessionId: string,
  tabId: string,
  opts?: { timeout?: number; quietMs?: number },
): Promise<StabilityResult> {
  const tab = ctx.getTab(sessionId, tabId);
  if (!tab) throw makeError(`Tab not found: ${tabId}`, ErrorCode.SESSION_NOT_FOUND);

  if (!tab.events) {
    return { stable: true, domStable: true, networkPending: 0, loadState: 'loaded' };
  }

  const maxWait = Math.min(opts?.timeout ?? 5000, 30000);
  const stable = await tab.events.waitForStable(maxWait, opts?.quietMs);
  ctx.sessionManager.updateActivity(sessionId);
  const state = tab.events.getStabilityState();
  return { ...state, stable };
}

/** 获取页面语义信息（支持显式 tabId） */
export async function getPageInfo(
  ctx: ToolContext,
  sessionId: string,
  tabId: string,
  opts?: { maxElements?: number; visibleOnly?: boolean },
): Promise<PageInfoResult> {
  const tab = ctx.getTab(sessionId, tabId);
  if (!tab) throw makeError(`Tab not found: ${tabId}`, ErrorCode.SESSION_NOT_FOUND);

  const limit = opts?.maxElements ?? 50;
  const filterVisible = opts?.visibleOnly ?? true;

  const [elements, analysis, regions] = await Promise.all([
    elementCollector.collect(tab.page),
    pageAnalyzer.analyze(tab.page),
    regionDetector.detect(tab.page),
  ]);

  let filtered = elements;

  // Filter to viewport-visible elements
  if (filterVisible) {
    const viewport = tab.page.viewport();
    if (viewport) {
      filtered = filtered.filter((el: any) => {
        const b = el.bounds;
        if (!b || (b.width === 0 && b.height === 0)) return true;
        return b.y + b.height > 0 && b.y < viewport.height
          && b.x + b.width > 0 && b.x < viewport.width;
      });
    }
  }

  // Sort by y position and truncate
  const totalElements = filtered.length;
  filtered.sort((a: any, b: any) => (a.bounds?.y ?? 0) - (b.bounds?.y ?? 0));
  const truncated = filtered.length > limit;
  if (truncated) filtered = filtered.slice(0, limit);

  // Mask sensitive field values
  for (const el of filtered as any[]) {
    if (el.type === 'textbox' || el.type === 'input') {
      const idLower = (el.id || '').toLowerCase();
      const labelLower = (el.label || '').toLowerCase();
      const isSensitive = idLower.includes('password') || idLower.includes('secret') || idLower.includes('token')
        || labelLower.includes('password') || labelLower.includes('secret') || labelLower.includes('token');
      if (isSensitive && el.state?.value) {
        el.state.value = '********';
      }
    }
  }

  ctx.sessionManager.updateActivity(sessionId);

  const result: PageInfoResult = {
    page: {
      url: tab.page.url(),
      title: await tab.page.title(),
      type: analysis.pageType,
      summary: analysis.summary,
    },
    elements: filtered,
    totalElements,
    truncated,
    regions,
    intents: analysis.intents,
    recommendedByIntent: recommendElementsByIntent(analysis.intents, filtered),
  };

  if (tab.events) {
    result.stability = tab.events.getStabilityState();
    const pending = tab.events.getPendingDialog();
    if (pending) result.pendingDialog = pending;
  }

  return result;
}

/** 提取页面文本内容（支持显式 tabId） */
export async function getPageContent(
  ctx: ToolContext,
  sessionId: string,
  tabId: string,
  opts?: { maxLength?: number },
): Promise<PageContentResult> {
  const tab = ctx.getTab(sessionId, tabId);
  if (!tab) throw makeError(`Tab not found: ${tabId}`, ErrorCode.SESSION_NOT_FOUND);

  const content = await contentExtractor.extract(tab.page);

  if (opts?.maxLength && content.sections) {
    let totalLen = 0;
    const truncatedSections: typeof content.sections = [];
    for (const section of content.sections) {
      const sectionText = section.text || '';
      if (totalLen + sectionText.length > opts.maxLength) {
        const remaining = opts.maxLength - totalLen;
        if (remaining > 0) {
          truncatedSections.push({ ...section, text: sectionText.slice(0, remaining) });
        }
        break;
      }
      truncatedSections.push(section);
      totalLen += sectionText.length;
    }
    content.sections = truncatedSections;
  }

  ctx.sessionManager.updateActivity(sessionId);
  return content;
}

/** 创建新标签页（可选导航到 URL） */
export async function createTab(
  ctx: ToolContext,
  sessionId: string,
  url?: string,
): Promise<CreateTabResult> {
  const tab = await ctx.sessionManager.createTab(sessionId);
  if (!tab) throw makeError(`Session not found: ${sessionId}`, ErrorCode.SESSION_NOT_FOUND);

  // Auto-switch to the new tab
  ctx.sessionManager.switchTab(sessionId, tab.id);

  let partial = false;
  if (url) {
    const check = await validateUrlAsync(url, ctx.urlOpts);
    if (!check.valid) {
      throw makeError(check.reason!, ErrorCode.INVALID_PARAMETER);
    }
    await ctx.injectCookies(tab.page);
    try {
      await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.message?.includes('timeout')) {
        partial = true;
      } else {
        throw err;
      }
    }
    tab.url = tab.page.url();
    await ctx.saveCookies(tab.page);
  }

  ctx.sessionManager.updateActivity(sessionId);
  return { tabId: tab.id, url: tab.page.url(), partial };
}

/** 关闭指定标签页 */
export async function closeTab(
  ctx: ToolContext,
  sessionId: string,
  tabId: string,
): Promise<{ success: boolean }> {
  const closed = await ctx.sessionManager.closeTab(sessionId, tabId);
  if (!closed) throw makeError(`Tab not found: ${tabId}`, ErrorCode.SESSION_NOT_FOUND);
  ctx.sessionManager.updateActivity(sessionId);
  return { success: true };
}

/** 模糊搜索页面元素 */
export async function findElement(
  ctx: ToolContext,
  sessionId: string,
  tabId: string,
  query: string,
  limit?: number,
): Promise<FindElementResult> {
  const tab = ctx.getTab(sessionId, tabId);
  if (!tab) throw makeError(`Tab not found: ${tabId}`, ErrorCode.SESSION_NOT_FOUND);

  const elements = await elementCollector.collect(tab.page);
  const candidates = elementMatcher.findByQuery(elements, query, limit ?? 5);
  ctx.sessionManager.updateActivity(sessionId);

  return {
    query,
    candidates: candidates.map((c) => ({
      id: c.element.id,
      label: c.element.label,
      type: c.element.type,
      score: c.score,
      matchReason: c.matchReason,
    })),
  };
}

/** 点击元素（支持显式 tabId） */
export async function click(
  ctx: ToolContext,
  sessionId: string,
  tabId: string,
  elementId: string,
): Promise<ClickResult> {
  const tab = ctx.getTab(sessionId, tabId);
  if (!tab) throw makeError(`Tab not found: ${tabId}`, ErrorCode.SESSION_NOT_FOUND);

  await executeAction(tab.page, 'click', elementId);
  // Small delay to allow popup/dialog events to fire
  await new Promise(r => setTimeout(r, 200));
  tab.url = tab.page.url();
  await ctx.saveCookies(tab.page);

  // Check for popup windows captured by PageEventTracker
  let newTabCreated: string | undefined;
  if (tab.events) {
    const popups = tab.events.getPopupPages();
    for (const popupPage of popups) {
      const newTab = await ctx.sessionManager.registerPopupAsTab(sessionId, popupPage);
      if (newTab) newTabCreated = newTab.id;
    }
    tab.events.clearPopupPages();
  }

  ctx.sessionManager.updateActivity(sessionId);
  const result: ClickResult = {
    success: true,
    page: { url: tab.page.url(), title: await tab.page.title() },
  };
  if (newTabCreated) result.newTabCreated = newTabCreated;
  if (tab.events) {
    const pending = tab.events.getPendingDialog();
    if (pending) result.dialog = pending;
  }
  return result;
}

/** 输入文本（支持显式 tabId） */
export async function typeText(
  ctx: ToolContext,
  sessionId: string,
  tabId: string,
  elementId: string,
  text: string,
  submit?: boolean,
): Promise<TypeTextResult> {
  const tab = ctx.getTab(sessionId, tabId);
  if (!tab) throw makeError(`Tab not found: ${tabId}`, ErrorCode.SESSION_NOT_FOUND);

  await executeAction(tab.page, 'type', elementId, text);
  if (submit) {
    await Promise.all([
      tab.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {}),
      tab.page.keyboard.press('Enter'),
    ]);
  }
  await ctx.saveCookies(tab.page);
  ctx.sessionManager.updateActivity(sessionId);
  return {
    success: true,
    page: { url: tab.page.url(), title: await tab.page.title() },
  };
}

// ===== pressKey constants =====

const ALLOWED_KEYS = new Set([
  'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
]);

const MODIFIER_COMBO_KEYS = new Set([
  ...ALLOWED_KEYS,
  ...'abcdefghijklmnopqrstuvwxyz'.split(''),
  ...'0123456789'.split(''),
]);

const BLOCKED_COMBOS: Array<{ modifiers: string[]; key: string }> = [
  { modifiers: ['Control'], key: 'w' },
  { modifiers: ['Meta'], key: 'w' },
  { modifiers: ['Control', 'Shift'], key: 'I' },
  { modifiers: ['Meta', 'Shift'], key: 'I' },
  { modifiers: ['Control', 'Shift'], key: 'J' },
  { modifiers: ['Meta', 'Shift'], key: 'J' },
  { modifiers: ['Control', 'Shift'], key: 'Delete' },
  { modifiers: ['Control'], key: 'q' },
  { modifiers: ['Meta'], key: 'q' },
];

function isComboAllowed(modifiers: string[], key: string): boolean {
  for (const blocked of BLOCKED_COMBOS) {
    const modSet = new Set(modifiers);
    const blockedSet = new Set(blocked.modifiers);
    if (modSet.size === blockedSet.size &&
        [...blockedSet].every(m => modSet.has(m)) &&
        key.toLowerCase() === blocked.key.toLowerCase()) {
      return false;
    }
  }
  return MODIFIER_COMBO_KEYS.has(key);
}

/** 按下键盘按键（支持显式 tabId + 修饰键组合） */
export async function pressKey(
  ctx: ToolContext,
  sessionId: string,
  tabId: string,
  key: string,
  modifiers?: string[],
): Promise<PressKeyResult> {
  const tab = ctx.getTab(sessionId, tabId);
  if (!tab) throw makeError(`Tab not found: ${tabId}`, ErrorCode.SESSION_NOT_FOUND);

  if (modifiers && modifiers.length > 0) {
    if (!isComboAllowed(modifiers, key)) {
      throw makeError(`不允许的组合键: ${modifiers.join('+')}+${key}`, ErrorCode.INVALID_PARAMETER);
    }
    for (const mod of modifiers) {
      await tab.page.keyboard.down(mod as KeyInput);
    }
    await tab.page.keyboard.press(key as KeyInput);
    for (let i = modifiers.length - 1; i >= 0; i--) {
      await tab.page.keyboard.up(modifiers[i] as KeyInput);
    }
  } else {
    if (!ALLOWED_KEYS.has(key)) {
      throw makeError(
        `不允许的按键: ${key}。允许: ${[...ALLOWED_KEYS].join(', ')}`,
        ErrorCode.INVALID_PARAMETER,
      );
    }
    await tab.page.keyboard.press(key as KeyInput);
  }

  await new Promise(r => setTimeout(r, 300));
  ctx.sessionManager.updateActivity(sessionId);
  return {
    success: true,
    page: { url: tab.page.url(), title: await tab.page.title() },
  };
}

/** 条件等待（支持显式 tabId） */
export async function wait(
  ctx: ToolContext,
  sessionId: string,
  tabId: string,
  opts: {
    condition?: 'time' | 'selector' | 'networkidle' | 'element_hidden';
    milliseconds?: number;
    selector?: string;
  },
): Promise<WaitResult> {
  const tab = ctx.getTab(sessionId, tabId);
  if (!tab) throw makeError(`Tab not found: ${tabId}`, ErrorCode.SESSION_NOT_FOUND);

  const { condition, milliseconds, selector } = opts;

  if (condition === 'networkidle') {
    await tab.page.waitForNetworkIdle({ timeout: milliseconds || 10000 });
  } else if (condition === 'element_hidden') {
    if (!selector) throw makeError('selector is required for element_hidden condition', ErrorCode.INVALID_PARAMETER);
    await tab.page.waitForSelector(selector, { hidden: true, timeout: milliseconds || 10000 });
  } else if (condition === 'selector' || (!condition && selector)) {
    if (!selector) throw makeError('selector is required for selector condition', ErrorCode.INVALID_PARAMETER);
    await tab.page.waitForSelector(selector, { timeout: milliseconds || 10000 });
  } else {
    await new Promise(r => setTimeout(r, Math.min(milliseconds || 1000, 30000)));
  }

  ctx.sessionManager.updateActivity(sessionId);
  return { success: true };
}
