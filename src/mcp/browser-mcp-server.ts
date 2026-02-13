import path from 'node:path';
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SessionManager } from '../browser/index.js';
import { CookieStore } from '../browser/CookieStore.js';
import { executeAction, escapeCSS, setValueByAccessibility } from '../browser/actions.js';
import { validateUrl, validateUrlAsync, type ValidateUrlOptions } from '../utils/url-validator.js';
import {
  ElementCollector,
  PageAnalyzer,
  RegionDetector,
  ContentExtractor,
  ElementMatcher,
} from '../semantic/index.js';
import * as toolActions from '../task/tool-actions.js';
import type { ToolContext } from '../task/tool-context.js';
import { RunManager } from '../task/run-manager.js';
import { ArtifactStore } from '../task/artifact-store.js';
import { registerTaskTools } from './task-tools.js';
import { enrichWithAiMarkdown } from './ai-markdown.js';
import type { KnowledgeCardStore } from '../memory/KnowledgeCardStore.js';
import { isSafeDomain } from '../memory/KnowledgeCardStore.js';
import { MemoryCapturer } from '../memory/MemoryCapturer.js';
import { MemoryInjector } from '../memory/MemoryInjector.js';

// Re-export TrustLevel and ErrorCode from canonical locations
export type { TrustLevel } from '../task/tool-context.js';
export { ErrorCode } from '../task/error-codes.js';

// Local import for use within this file
import type { TrustLevel } from '../task/tool-context.js';
import { ErrorCode } from '../task/error-codes.js';

export interface BrowserMcpServerOptions {
  headless?: boolean | 'new';
  trustLevel?: TrustLevel;
  /** @deprecated Use trustLevel instead */
  urlValidation?: ValidateUrlOptions;
  onSessionCreated?: (sessionId: string) => void;
  knowledgeStore?: KnowledgeCardStore;
}

export function createBrowserMcpServer(sessionManager: SessionManager, cookieStore?: CookieStore, options?: BrowserMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: 'browser-mcp-server', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  // Derive URL validation options from trustLevel (with backward compat for urlValidation)
  const isRemote = options?.trustLevel === 'remote';
  const urlOpts: ValidateUrlOptions = isRemote
    ? { blockPrivate: true, allowFile: false }
    : options?.trustLevel === 'local'
      ? { allowFile: true, blockPrivate: false }
      : options?.urlValidation ?? {};

  const elementCollector = new ElementCollector();
  const pageAnalyzer = new PageAnalyzer();
  const regionDetector = new RegionDetector();
  const contentExtractor = new ContentExtractor();
  const elementMatcher = new ElementMatcher();

  /** Save all cookies from a page via CDP (includes cross-domain SSO cookies) */
  async function saveCookiesFromPage(page: import('puppeteer-core').Page): Promise<void> {
    if (!cookieStore) return;
    try {
      const client = await page.createCDPSession();
      try {
        const { cookies } = await client.send('Network.getAllCookies');
        cookieStore.save(page.url(), cookies as any[]);
      } finally {
        await client.detach().catch(() => {});
      }
    } catch {}
  }

  /** Inject ALL saved cookies into a page via CDP (supports cross-domain SSO) */
  async function injectCookiesToPage(page: import('puppeteer-core').Page): Promise<void> {
    if (!cookieStore) return;
    const allCookies = cookieStore.getAll();
    if (allCookies.length === 0) return;
    try {
      const client = await page.createCDPSession();
      try {
        await client.send('Network.setCookies', { cookies: allCookies as any[] });
      } finally {
        await client.detach().catch(() => {});
      }
    } catch {}
  }

  // Default session tracking (with promise lock to prevent race conditions)
  let defaultSessionId: string | null = null;
  let defaultSessionPromise: Promise<string> | null = null;

  // Helper: resolve sessionId — use provided or fall back to default, auto-create if needed
  async function resolveSession(sessionId?: string): Promise<string> {
    if (sessionId) return sessionId;
    // Check if default session still exists
    if (defaultSessionId && sessionManager.get(defaultSessionId)) {
      return defaultSessionId;
    }
    // Use promise lock to prevent concurrent creation of multiple default sessions
    if (!defaultSessionPromise) {
      defaultSessionPromise = (async () => {
        try {
          const sessionOpts = options?.headless !== undefined ? { headless: options.headless } : {};
          const session = await sessionManager.create(sessionOpts);
          defaultSessionId = session.id;
          defaultSessionPromise = null;
          options?.onSessionCreated?.(session.id);
          return session.id;
        } catch (err) {
          defaultSessionPromise = null;  // Reset lock to allow retry
          throw err;
        }
      })();
    }
    return defaultSessionPromise;
  }

  // Create an isolated session for task runs (not bound to defaultSessionId)
  async function createIsolatedSession(): Promise<string> {
    const sessionOpts = options?.headless !== undefined ? { headless: options.headless } : {};
    const session = await sessionManager.create(sessionOpts);
    options?.onSessionCreated?.(session.id);
    return session.id;
  }

  // Helper: get active tab for a session
  function getActiveTab(sessionId: string) {
    const tab = sessionManager.getActiveTab(sessionId);
    if (!tab) {
      const err = new Error(`Session or active tab not found: ${sessionId}`);
      (err as any).errorCode = ErrorCode.SESSION_NOT_FOUND;
      throw err;
    }
    return tab;
  }

  // Helper: wrap result as MCP text content
  function textResult(data: unknown, toolName?: string) {
    const payload = toolName ? enrichWithAiMarkdown(toolName, data) : data;
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  }

  // Helper: wrap error as MCP error content
  function errorResult(message: string, errorCode?: ErrorCode) {
    const payload: { error: string; errorCode?: string; hint?: string } = { error: message };
    if (errorCode) payload.errorCode = errorCode;
    if (errorCode === ErrorCode.ELEMENT_NOT_FOUND) {
      payload.hint = 'Element IDs expire after navigation or DOM changes. Call get_page_info to refresh.';
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError: true as const };
  }

  // Helper: classify error to errorCode (more specific patterns first)
  function classifyError(err: any): ErrorCode | undefined {
    if (err.errorCode) return err.errorCode;
    const msg = err.message || '';
    if (msg.includes('Element not found') || msg.includes('No element found')) return ErrorCode.ELEMENT_NOT_FOUND;
    if (msg.includes('crashed') || msg.includes('detached') || msg.includes('Target closed')) return ErrorCode.PAGE_CRASHED;
    if (msg.includes('timeout') || msg.includes('Timeout') || err.name === 'TimeoutError') return ErrorCode.NAVIGATION_TIMEOUT;
    if (msg.includes('Session not found') || msg.includes('session not found') || msg.includes('Session or active tab not found')) return ErrorCode.SESSION_NOT_FOUND;
    return undefined;
  }

  function invalidParameterError(message: string): Error {
    const err = new Error(message);
    (err as any).errorCode = ErrorCode.INVALID_PARAMETER;
    return err;
  }

  function summarizeNetworkIssues(logs: any[]): Array<{ kind: string; count: number; sample?: string }> {
    const timeoutLogs = logs.filter((l: any) => String(l?.error || '').toLowerCase().includes('timeout'));
    const failedLogs = logs.filter((l: any) => Boolean(l?.error));
    const httpErrorLogs = logs.filter((l: any) => typeof l?.status === 'number' && l.status >= 400);
    const slowLogs = logs.filter((l: any) => (l?.timing?.duration ?? 0) > 1000);

    const issues: Array<{ kind: string; count: number; sample?: string }> = [];
    if (timeoutLogs.length > 0) issues.push({ kind: 'timeout', count: timeoutLogs.length, sample: timeoutLogs[0]?.url });
    if (failedLogs.length > 0) issues.push({ kind: 'request_failed', count: failedLogs.length, sample: failedLogs[0]?.url });
    if (httpErrorLogs.length > 0) issues.push({ kind: 'http_error', count: httpErrorLogs.length, sample: httpErrorLogs[0]?.url });
    if (slowLogs.length > 0) issues.push({ kind: 'slow_request', count: slowLogs.length, sample: slowLogs[0]?.url });
    return issues.slice(0, 5);
  }

  function summarizeConsoleIssues(logs: any[]): Array<{ kind: string; count: number; sample?: string }> {
    const levels = ['error', 'warn', 'info', 'log', 'debug'] as const;
    const issues: Array<{ kind: string; count: number; sample?: string }> = [];
    for (const level of levels) {
      const levelLogs = logs.filter((l: any) => l?.level === level);
      if (levelLogs.length > 0) {
        issues.push({ kind: level, count: levelLogs.length, sample: levelLogs[0]?.text });
      }
    }
    return issues.slice(0, 5);
  }

  // Helper: wrap async handler with try/catch to prevent unhandled exceptions
  function safe<T extends (...args: any[]) => Promise<any>>(fn: T): T {
    return (async (...args: any[]) => {
      try {
        return await fn(...args);
      } catch (err: any) {
        const code = classifyError(err);
        return errorResult(err.message || 'Unknown error', code);
      }
    }) as T;
  }

  // ToolContext for extracted toolActions (shared by MCP handlers and template executor)
  const toolCtx: ToolContext = {
    sessionManager,
    cookieStore,
    urlOpts,
    trustLevel: options?.trustLevel ?? 'local',
    resolveSession,
    getActiveTab,
    getTab: (sid: string, tid: string) => sessionManager.getTab(sid, tid),
    injectCookies: injectCookiesToPage,
    saveCookies: saveCookiesFromPage,
  };

  // RunManager + ArtifactStore for task template execution
  const runManager = new RunManager();
  const artifactStore = new ArtifactStore();

  // ===== create_session / close_session =====

  server.tool(
    'create_session',
    '创建新的浏览器会话',
    {},
    safe(async () => {
      const sessionOpts = options?.headless !== undefined ? { headless: options.headless } : {};
      const session = await sessionManager.create(sessionOpts);
      // If no default session, set this as default
      if (!defaultSessionId || !sessionManager.get(defaultSessionId)) {
        defaultSessionId = session.id;
      }
      options?.onSessionCreated?.(session.id);
      return textResult({ sessionId: session.id }, 'create_session');
    })
  );

  server.tool(
    'close_session',
    '关闭浏览器会话（headful 会话会保留，不会被自动关闭）',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      force: z.boolean().optional().describe('是否强制关闭 headful 会话，默认 false'),
    },
    safe(async ({ sessionId: rawSessionId, force }) => {
      // No-op if no sessionId provided and no default session exists
      if (!rawSessionId && !defaultSessionId && !defaultSessionPromise) {
        return textResult({ success: true, reason: 'No active session to close' }, 'close_session');
      }
      const sessionId = await resolveSession(rawSessionId);
      await sessionManager.saveAllCookies(sessionId);

      // 默认保留 headful 会话，force=true 时允许主动关闭。
      const session = sessionManager.get(sessionId);
      if (session && !session.headless && !force) {
        return textResult({ success: true, kept: true, reason: 'headful session preserved (set force=true to close)' }, 'close_session');
      }

      const closed = await sessionManager.close(sessionId);
      // Clear default session if it was closed
      if (sessionId === defaultSessionId) {
        defaultSessionId = null;
      }
      return textResult({ success: closed }, 'close_session');
    })
  );

  // ===== navigate =====
  server.tool(
    'navigate',
    '导航到指定URL',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      url: z.string().describe('要导航到的完整URL'),
    },
    safe(async ({ sessionId: rawSessionId, url }) => {
      const sessionId = await resolveSession(rawSessionId);
      const result = await toolActions.navigate(toolCtx, sessionId, url);
      return textResult(result, 'navigate');
    })
  );

  // ===== get_page_info =====
  server.tool(
    'get_page_info',
    '获取当前页面的语义信息，包括可交互元素列表',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      maxElements: z.number().optional().describe('最大返回元素数量，默认50'),
      visibleOnly: z.boolean().optional().describe('是否只返回视口内可见元素，默认true'),
    },
    safe(async ({ sessionId: rawSessionId, maxElements, visibleOnly }) => {
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      // Fetch with a generous limit first to measure page complexity
      const fetchLimit = maxElements ?? 200;
      const result = await toolActions.getPageInfo(toolCtx, sessionId, tab.id, { maxElements: fetchLimit, visibleOnly });
      const totalElements = Array.isArray(result.elements) ? result.elements.length : 0;

      // Adaptive limit: if caller specified maxElements, respect it; otherwise auto-adjust
      let effectiveLimit: number;
      if (maxElements !== undefined) {
        effectiveLimit = maxElements;
      } else if (totalElements <= 30) {
        // Small page — return all
        effectiveLimit = totalElements;
      } else if (totalElements <= 100) {
        // Medium page — default 50, prioritize inputs > buttons > links
        effectiveLimit = 50;
      } else {
        // Complex page — default 30, but always include intent-recommended elements
        effectiveLimit = 30;
      }

      // Prioritize elements: inputs first, then buttons, then links, then rest
      let elements = Array.isArray(result.elements) ? result.elements : [];
      if (elements.length > effectiveLimit) {
        const intentIds = new Set<string>();
        if (Array.isArray(result.recommendedByIntent)) {
          for (const rec of result.recommendedByIntent) {
            if (Array.isArray(rec?.suggestedElementIds)) {
              for (const id of rec.suggestedElementIds) intentIds.add(id);
            }
          }
        }
        const intentElements = elements.filter((e: any) => intentIds.has(e.id));
        const rest = elements.filter((e: any) => !intentIds.has(e.id));
        const inputs = rest.filter((e: any) => e.type === 'input' || e.type === 'textarea' || e.type === 'select');
        const buttons = rest.filter((e: any) => e.type === 'button' || e.type === 'submit');
        const links = rest.filter((e: any) => e.type === 'link');
        const others = rest.filter((e: any) =>
          !['input', 'textarea', 'select', 'button', 'submit', 'link'].includes(e.type)
        );
        const prioritized = [...intentElements, ...inputs, ...buttons, ...links, ...others];
        elements = prioritized.slice(0, effectiveLimit);
      }

      const hasMore = totalElements > effectiveLimit;
      const nextCursor = hasMore
        ? {
            strategy: 'increase_max_elements',
            suggestedMaxElements: Math.min(Math.max(effectiveLimit * 2, 100), 1000),
          }
        : null;
      return textResult({ ...result, elements, totalElements, hasMore, nextCursor }, 'get_page_info');
    })
  );

  // ===== get_page_content =====
  server.tool(
    'get_page_content',
    '提取当前页面的文本内容',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      maxLength: z.number().optional().describe('返回内容最大字符数，超过则截断sections'),
    },
    safe(async ({ sessionId: rawSessionId, maxLength }) => {
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      const result = await toolActions.getPageContent(toolCtx, sessionId, tab.id, { maxLength });
      return textResult(result, 'get_page_content');
    })
  );

  // ===== click =====
  server.tool(
    'click',
    '点击页面上的元素',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      element_id: z.string().describe('要点击的元素的语义ID'),
    },
    safe(async ({ sessionId: rawSessionId, element_id }) => {
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      await executeAction(tab.page, 'click', element_id);
      // Small delay to allow popup/dialog events to fire
      await new Promise(r => setTimeout(r, 200));
      tab.url = tab.page.url();
      await saveCookiesFromPage(tab.page);
      // Check for popup windows captured by PageEventTracker
      let newTabCreated: string | undefined;
      if (tab.events) {
        const popups = tab.events.getPopupPages();
        for (const popupPage of popups) {
          const newTab = await sessionManager.registerPopupAsTab(sessionId, popupPage);
          if (newTab) newTabCreated = newTab.id;
        }
        tab.events.clearPopupPages();
      }
      sessionManager.updateActivity(sessionId);
      const result: any = {
        success: true,
        page: { url: tab.page.url(), title: await tab.page.title() },
      };
      if (newTabCreated) result.newTabCreated = newTabCreated;
      if (tab.events) {
        const pending = tab.events.getPendingDialog();
        if (pending) result.dialog = pending;
      }
      return textResult(result, 'click');
    })
  );

  // ===== type_text =====
  server.tool(
    'type_text',
    '在输入框中输入文本。设置 submit=true 可在输入后自动按回车提交（适用于搜索框）',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      element_id: z.string().describe('输入框的语义ID'),
      text: z.string().describe('要输入的文本内容'),
      submit: z.boolean().optional().describe('输入后是否按回车提交，默认 false'),
    },
    safe(async ({ sessionId: rawSessionId, element_id, text, submit }) => {
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      await executeAction(tab.page, 'type', element_id, text);
      if (submit) {
        await Promise.all([
          tab.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {}),
          tab.page.keyboard.press('Enter'),
        ]);
      }
      await saveCookiesFromPage(tab.page);
      sessionManager.updateActivity(sessionId);
      return textResult({
        success: true,
        page: { url: tab.page.url(), title: await tab.page.title() },
      }, 'type_text');
    })
  );

  // ===== scroll =====
  server.tool(
    'scroll',
    '滚动页面',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      direction: z.string().describe('滚动方向：down 或 up'),
    },
    safe(async ({ sessionId: rawSessionId, direction }) => {
      if (direction !== 'down' && direction !== 'up') {
        throw invalidParameterError('direction must be one of: down, up');
      }
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      await executeAction(tab.page, 'scroll', undefined, direction);
      sessionManager.updateActivity(sessionId);
      return textResult({ success: true }, 'scroll');
    })
  );

  // ===== press_key =====
  const ALLOWED_KEYS = new Set([
    'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Space',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown',
  ]);

  const ALLOWED_MODIFIERS = ['Control', 'Shift', 'Alt', 'Meta'] as const;

  // Keys allowed in modifier combos: a-z, 0-9, plus original ALLOWED_KEYS
  const MODIFIER_COMBO_KEYS = new Set([
    ...ALLOWED_KEYS,
    ...'abcdefghijklmnopqrstuvwxyz'.split(''),
    ...'0123456789'.split(''),
  ]);

  // Dangerous combos that could close tabs, open devtools, quit browser, or clear data
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
    // Check against blocked combos
    for (const blocked of BLOCKED_COMBOS) {
      const modSet = new Set(modifiers);
      const blockedSet = new Set(blocked.modifiers);
      if (modSet.size === blockedSet.size &&
          [...blockedSet].every(m => modSet.has(m)) &&
          key.toLowerCase() === blocked.key.toLowerCase()) {
        return false;
      }
    }
    // Key must be in the combo whitelist
    return MODIFIER_COMBO_KEYS.has(key);
  }

  server.tool(
    'press_key',
    '按下键盘按键，支持组合键（如 Ctrl+A, Shift+Tab）。modifiers 可选: Control, Shift, Alt, Meta',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      key: z.string().describe('按键名称，如 Enter, Escape, Tab, ArrowDown, a, c'),
      modifiers: z.array(z.string()).optional().describe('修饰键数组，如 ["Control"] 表示 Ctrl+key'),
    },
    safe(async ({ sessionId: rawSessionId, key, modifiers }) => {
      if (modifiers && modifiers.length > 0) {
        for (const mod of modifiers) {
          if (!ALLOWED_MODIFIERS.includes(mod as any)) {
            throw invalidParameterError(`不允许的修饰键: ${mod}。允许: ${ALLOWED_MODIFIERS.join(', ')}`);
          }
        }
        // Combo key mode
        if (!isComboAllowed(modifiers, key)) {
          throw invalidParameterError(`不允许的组合键: ${modifiers.join('+')}+${key}`);
        }
        const sessionId = await resolveSession(rawSessionId);
        const tab = getActiveTab(sessionId);
        // Press modifiers down in order
        for (const mod of modifiers) {
          await tab.page.keyboard.down(mod);
        }
        await tab.page.keyboard.press(key);
        // Release modifiers in reverse order
        for (let i = modifiers.length - 1; i >= 0; i--) {
          await tab.page.keyboard.up(modifiers[i]);
        }
        await new Promise(r => setTimeout(r, 300));
        sessionManager.updateActivity(sessionId);
        return textResult({
          success: true,
          page: { url: tab.page.url(), title: await tab.page.title() },
        }, 'press_key');
      }
      // Single key mode (original logic)
      if (!ALLOWED_KEYS.has(key)) {
        throw invalidParameterError(`不允许的按键: ${key}。允许: ${[...ALLOWED_KEYS].join(', ')}`);
      }
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      await tab.page.keyboard.press(key);
      await new Promise(r => setTimeout(r, 300));
      sessionManager.updateActivity(sessionId);
      return textResult({
        success: true,
        page: { url: tab.page.url(), title: await tab.page.title() },
      }, 'press_key');
    })
  );

  // ===== go_back =====
  server.tool(
    'go_back',
    '返回上一页',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
    },
    safe(async ({ sessionId: rawSessionId }) => {
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      await executeAction(tab.page, 'back');
      tab.url = tab.page.url();
      sessionManager.updateActivity(sessionId);
      return textResult({
        success: true,
        page: { url: tab.page.url(), title: await tab.page.title() },
      }, 'go_back');
    })
  );

  // ===== find_element =====
  server.tool(
    'find_element',
    '通过自然语言描述模糊匹配页面元素',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      query: z.string().describe('用自然语言描述要查找的元素'),
    },
    safe(async ({ sessionId: rawSessionId, query }) => {
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      const elements = await elementCollector.collect(tab.page);
      const candidates = elementMatcher.findByQuery(elements, query, 5);
      sessionManager.updateActivity(sessionId);
      return textResult({
        query,
        candidates: candidates.map((c) => ({
          id: c.element.id,
          label: c.element.label,
          type: c.element.type,
          score: c.score,
          matchReason: c.matchReason,
        })),
      }, 'find_element');
    })
  );

  // ===== wait =====
  server.tool(
    'wait',
    '按条件等待：time / selector / networkidle / element_hidden',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      milliseconds: z.number().optional().describe('等待的毫秒数，默认1000'),
      selector: z.string().optional().describe('等待指定CSS选择器的元素出现'),
      condition: z.string().optional().describe('等待条件类型：time / selector / networkidle / element_hidden'),
    },
    safe(async ({ sessionId: rawSessionId, milliseconds, selector, condition }) => {
      const allowedConditions = ['time', 'selector', 'networkidle', 'element_hidden'] as const;
      if (condition !== undefined && !allowedConditions.includes(condition as any)) {
        throw invalidParameterError('condition must be one of: time, selector, networkidle, element_hidden');
      }

      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      // For condition-based waits, default timeout is 10s; for simple time wait, default is 1s
      if (condition === 'networkidle') {
        await tab.page.waitForNetworkIdle({ timeout: milliseconds || 10000 });
      } else if (condition === 'element_hidden') {
        if (!selector) throw invalidParameterError('selector is required for element_hidden condition');
        await tab.page.waitForSelector(selector, { hidden: true, timeout: milliseconds || 10000 });
      } else if (condition === 'selector' || (!condition && selector)) {
        if (!selector) throw invalidParameterError('selector is required for selector condition');
        await tab.page.waitForSelector(selector, { timeout: milliseconds || 10000 });
      } else {
        await new Promise(r => setTimeout(r, Math.min(milliseconds || 1000, 30000)));
      }

      sessionManager.updateActivity(sessionId);
      return textResult({ success: true }, 'wait');
    })
  );

  // ===== execute_javascript =====
  server.tool(
    'execute_javascript',
    '在当前页面执行 JavaScript（仅 local 模式可用）。脚本需通过表达式或 return 返回数据，console.log 不会作为返回值',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      script: z.string().describe('要执行的 JavaScript 代码'),
    },
    safe(async ({ sessionId: rawSessionId, script }) => {
      if (isRemote) {
        return errorResult('execute_javascript is disabled in remote mode', ErrorCode.INVALID_PARAMETER);
      }
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      let result: any;
      try {
        result = await tab.page.evaluate(script);
      } catch (err: any) {
        // Retry with IIFE scope isolation on common errors
        if (err.message?.includes('has already been declared') || err.message?.includes('Illegal return statement')) {
          try {
            result = await tab.page.evaluate(`(() => {\n${script}\n})()`);
          } catch (retryErr: any) {
            const error = new Error(retryErr.message || 'Script execution failed');
            (error as any).errorCode = ErrorCode.EXECUTION_ERROR;
            throw error;
          }
        } else {
          const error = new Error(err.message || 'Script execution failed');
          (error as any).errorCode = ErrorCode.EXECUTION_ERROR;
          throw error;
        }
      }
      sessionManager.updateActivity(sessionId);
      if (result === undefined || result === null) {
        return textResult({ result: null, hint: '脚本无返回值。如需获取数据，请在脚本末尾使用表达式（如 document.title）或 return 语句。console.log 的输出不会返回。' }, 'execute_javascript');
      }
      let serialized = JSON.stringify(result);
      const truncated = serialized && serialized.length > 4000;
      if (truncated) {
        serialized = serialized.slice(0, 4000) + '...(truncated)';
      }
      return textResult({ result: truncated ? serialized : result, truncated }, 'execute_javascript');
    })
  );

  // ===== select_option =====
  server.tool(
    'select_option',
    '选择下拉框中的选项',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      element_id: z.string().describe('下拉框的语义ID'),
      value: z.string().describe('要选择的选项值'),
    },
    safe(async ({ sessionId: rawSessionId, element_id, value }) => {
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      await executeAction(tab.page, 'select', element_id, value);
      sessionManager.updateActivity(sessionId);
      return textResult({ success: true }, 'select_option');
    })
  );

  // ===== hover =====
  server.tool(
    'hover',
    '将鼠标悬停在页面元素上（触发 tooltip/dropdown 等）',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      element_id: z.string().describe('要悬停的元素的语义ID'),
    },
    safe(async ({ sessionId: rawSessionId, element_id }) => {
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      await executeAction(tab.page, 'hover', element_id);
      sessionManager.updateActivity(sessionId);
      return textResult({ success: true }, 'hover');
    })
  );

  // ===== close_tab =====
  server.tool(
    'close_tab',
    '关闭指定标签页',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      tabId: z.string().describe('要关闭的标签页ID'),
    },
    safe(async ({ sessionId: rawSessionId, tabId }) => {
      const sessionId = await resolveSession(rawSessionId);
      const result = await toolActions.closeTab(toolCtx, sessionId, tabId);
      return textResult(result, 'close_tab');
    })
  );

  // ===== switch_tab =====
  server.tool(
    'switch_tab',
    '切换到指定标签页',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      tabId: z.string().describe('要切换到的标签页ID'),
    },
    safe(async ({ sessionId: rawSessionId, tabId }) => {
      const sessionId = await resolveSession(rawSessionId);
      const switched = sessionManager.switchTab(sessionId, tabId);
      if (!switched) throw new Error(`Tab not found: ${tabId}`);
      sessionManager.updateActivity(sessionId);
      const tab = sessionManager.getActiveTab(sessionId);
      if (!tab) throw new Error(`Active tab not available after switch: ${tabId}`);
      return textResult({
        success: true,
        page: { url: tab.page.url(), title: await tab.page.title() },
      }, 'switch_tab');
    })
  );

  // ===== create_tab =====
  server.tool(
    'create_tab',
    '在当前会话中创建新标签页',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      url: z.string().optional().describe('新标签页要导航到的URL'),
    },
    safe(async ({ sessionId: rawSessionId, url }) => {
      const sessionId = await resolveSession(rawSessionId);
      const result = await toolActions.createTab(toolCtx, sessionId, url);
      return textResult(result, 'create_tab');
    })
  );

  // ===== list_tabs =====
  server.tool(
    'list_tabs',
    '列出当前会话的所有标签页',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
    },
    safe(async ({ sessionId: rawSessionId }) => {
      const sessionId = await resolveSession(rawSessionId);
      const session = sessionManager.get(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      const tabs = sessionManager.listTabs(sessionId);
      sessionManager.updateActivity(sessionId);
      const tabItems = await Promise.all(tabs.map(async (t) => {
        let title = '';
        try { title = await t.page.title(); } catch {}
        return { id: t.id, url: t.page.url(), title };
      }));
      return textResult({
        activeTabId: session.activeTabId,
        tabs: tabItems,
        hasMore: false,
        nextCursor: null,
      }, 'list_tabs');
    })
  );

  // ===== screenshot =====
  server.tool(
    'screenshot',
    '截取当前页面的屏幕截图，支持全页截图、元素截图、格式和质量选项',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      fullPage: z.boolean().optional().describe('是否截取整个页面（包括滚动区域），默认 false'),
      element_id: z.string().optional().describe('截取指定元素的截图（优先于 fullPage）'),
      format: z.string().optional().describe('截图格式：png / jpeg / webp，默认 png'),
      quality: z.number().min(0).max(100).optional().describe('图片质量（仅 jpeg/webp 有效），默认 80'),
    },
    safe(async ({ sessionId: rawSessionId, fullPage, element_id, format, quality }) => {
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);

      const imgFormat = format || 'png';
      if (!['png', 'jpeg', 'webp'].includes(imgFormat)) {
        throw invalidParameterError('format must be one of: png, jpeg, webp');
      }
      const mimeType = `image/${imgFormat}` as const;
      const screenshotOpts: Record<string, any> = {
        encoding: 'base64',
        type: imgFormat,
      };
      if ((imgFormat === 'jpeg' || imgFormat === 'webp') && quality !== undefined) {
        screenshotOpts.quality = quality;
      } else if (imgFormat === 'jpeg' || imgFormat === 'webp') {
        screenshotOpts.quality = 80;
      }

      let base64: string;

      if (element_id) {
        // Element screenshot (takes priority over fullPage)
        const selector = `[data-semantic-id="${escapeCSS(element_id)}"]`;
        const elementHandle = await tab.page.$(selector);
        if (!elementHandle) {
          const err = new Error(`Element not found: ${element_id}`);
          (err as any).errorCode = ErrorCode.ELEMENT_NOT_FOUND;
          throw err;
        }
        base64 = await elementHandle.screenshot(screenshotOpts) as unknown as string;
      } else {
        if (fullPage) screenshotOpts.fullPage = true;
        base64 = await tab.page.screenshot(screenshotOpts) as unknown as string;
      }

      sessionManager.updateActivity(sessionId);
      const pageUrl = tab.page.url();
      const pageTitle = await tab.page.title().catch(() => '');
      const screenshotMeta = enrichWithAiMarkdown('screenshot', {
        captured: true,
        url: pageUrl,
        title: pageTitle,
        fullPage: !!fullPage,
        element: element_id || null,
      });
      return {
        content: [
          // Some MCP clients only render the first content block; keep image first for compatibility.
          { type: 'image' as const, data: base64, mimeType },
          { type: 'text' as const, text: JSON.stringify(screenshotMeta) },
        ],
      };
    })
  );

  // ===== set_value =====
  server.tool(
    'set_value',
    '直接设置元素的值（适用于富文本编辑器、contenteditable 等 type_text 无法处理的场景）',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      element_id: z.string().describe('目标元素的语义ID'),
      value: z.string().describe('要设置的值'),
      isHtml: z.boolean().optional().describe('是否以 HTML 格式设置（仅 contenteditable 有效），默认 false'),
    },
    safe(async ({ sessionId: rawSessionId, element_id, value, isHtml }) => {
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      const html = isHtml ?? false;

      // Try data-semantic-id selector first
      const selector = `[data-semantic-id="${escapeCSS(element_id)}"]`;
      const found = await tab.page.$(selector);

      if (found) {
        await tab.page.evaluate((sel, val, useHtml) => {
          const el = document.querySelector(sel) as any;
          if (!el) throw new Error('Element not found');
          const tag = el.tagName?.toLowerCase();
          if (tag === 'input' || tag === 'textarea') {
            el.focus();
            el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (el.isContentEditable || el.contentEditable === 'true') {
            el.focus();
            if (useHtml) {
              el.innerHTML = val;
            } else {
              el.innerText = val;
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            throw new Error('Element is not an input, textarea, or contenteditable');
          }
        }, selector, value, html);
      } else {
        // Fallback to accessibility tree
        await setValueByAccessibility(tab.page, element_id, value, html);
      }

      sessionManager.updateActivity(sessionId);
      return textResult({ success: true }, 'set_value');
    })
  );

  // ===== handle_dialog =====
  server.tool(
    'handle_dialog',
    '处理页面弹窗（alert/confirm/prompt），接受或拒绝',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      action: z.string().describe('accept 接受弹窗，dismiss 拒绝弹窗'),
      text: z.string().optional().describe('为 prompt 弹窗提供输入文本'),
    },
    safe(async ({ sessionId: rawSessionId, action, text }) => {
      if (action !== 'accept' && action !== 'dismiss') {
        throw invalidParameterError('action must be one of: accept, dismiss');
      }
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      if (!tab.events) {
        return textResult({ success: false, reason: 'Event tracking not available' }, 'handle_dialog');
      }
      const pending = tab.events.getPendingDialog();
      if (!pending) {
        return textResult({ success: false, reason: 'No pending dialog' }, 'handle_dialog');
      }
      await tab.events.handleDialog(action, text);
      sessionManager.updateActivity(sessionId);
      return textResult({ success: true, dialog: pending }, 'handle_dialog');
    })
  );

  // ===== get_dialog_info =====
  server.tool(
    'get_dialog_info',
    '获取页面弹窗信息和历史记录',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
    },
    safe(async ({ sessionId: rawSessionId }) => {
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      if (!tab.events) {
        return textResult({ pendingDialog: null, dialogHistory: [], hasMore: false, nextCursor: null }, 'get_dialog_info');
      }
      sessionManager.updateActivity(sessionId);
      return textResult({
        pendingDialog: tab.events.getPendingDialog(),
        dialogHistory: tab.events.getDialogs(),
        hasMore: false,
        nextCursor: null,
      }, 'get_dialog_info');
    })
  );

  // ===== wait_for_stable =====
  server.tool(
    'wait_for_stable',
    '等待页面 DOM 稳定（无新增/删除节点且无待处理网络请求）',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      timeout: z.number().optional().describe('最大等待毫秒数，默认5000，上限30000'),
      quietMs: z.number().optional().describe('DOM 静默时间阈值，默认500ms'),
    },
    safe(async ({ sessionId: rawSessionId, timeout, quietMs }) => {
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      const result = await toolActions.waitForStable(toolCtx, sessionId, tab.id, { timeout, quietMs });
      return textResult(result, 'wait_for_stable');
    })
  );

  // ===== get_network_logs =====
  server.tool(
    'get_network_logs',
    '获取页面网络请求日志',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      filter: z.string().optional().describe('过滤类型：all=全部, xhr=仅XHR/Fetch, failed=仅失败, slow=慢请求(>1s)'),
      maxEntries: z.number().optional().describe('最大返回条数，默认50'),
      includeHeaders: z.boolean().optional().describe('是否包含请求/响应头，默认false'),
      urlPattern: z.string().optional().describe('URL 匹配模式（子串匹配）'),
    },
    safe(async ({ sessionId: rawSessionId, filter, maxEntries, includeHeaders, urlPattern }) => {
      if (filter !== undefined && !['all', 'xhr', 'failed', 'slow'].includes(filter)) {
        throw invalidParameterError('filter must be one of: all, xhr, failed, slow');
      }
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      if (!tab.events) {
        return textResult({ logs: [], totalCount: 0, truncated: false, topIssues: [], hasMore: false, nextCursor: null }, 'get_network_logs');
      }
      let logs = tab.events.getNetworkLogs();
      const totalCount = logs.length;

      // Apply filters
      const filterType = filter ?? 'all';
      if (filterType === 'xhr') {
        logs = logs.filter(l => l.isXHR);
      } else if (filterType === 'failed') {
        logs = logs.filter(l => !!l.error);
      } else if (filterType === 'slow') {
        logs = logs.filter(l => (l.timing?.duration ?? 0) > 1000);
      }

      if (urlPattern) {
        logs = logs.filter(l => l.url.includes(urlPattern));
      }

      // Strip headers if not requested
      if (!includeHeaders) {
        logs = logs.map(({ headers, responseHeaders, ...rest }) => rest as any);
      }

      // Truncate to maxEntries (take most recent)
      const limit = maxEntries ?? 50;
      const truncated = logs.length > limit;
      if (truncated) {
        logs = logs.slice(-limit);
      }

      sessionManager.updateActivity(sessionId);
      const hasMore = truncated;
      const nextCursor = hasMore
        ? { strategy: 'increase_max_entries', suggestedMaxEntries: Math.min((limit || 50) * 2, 1000) }
        : null;
      const topIssues = summarizeNetworkIssues(logs);
      return textResult({ logs, totalCount, truncated, topIssues, hasMore, nextCursor }, 'get_network_logs');
    })
  );

  // ===== get_console_logs =====
  server.tool(
    'get_console_logs',
    '获取页面控制台日志',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      level: z.string().optional().describe('日志级别过滤：error / warn / log / info / debug / all，默认只返回 error+warn'),
      maxEntries: z.number().optional().describe('最大返回条数，默认50'),
    },
    safe(async ({ sessionId: rawSessionId, level, maxEntries }) => {
      if (level !== undefined && !['error', 'warn', 'log', 'info', 'debug', 'all'].includes(level)) {
        throw invalidParameterError('level must be one of: error, warn, log, info, debug, all');
      }
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      if (!tab.events) {
        return textResult({ logs: [], truncated: false, topIssues: [], hasMore: false, nextCursor: null }, 'get_console_logs');
      }
      let logs = tab.events.getConsoleLogs();

      // Filter by level (default: error + warn)
      if (!level || level === 'error') {
        // Default or 'error': return both error and warn
        logs = logs.filter(l => l.level === 'error' || l.level === 'warn');
      } else if (level !== 'all') {
        logs = logs.filter(l => l.level === level);
      }

      const limit = maxEntries ?? 50;
      const truncated = logs.length > limit;
      if (truncated) {
        logs = logs.slice(-limit);
      }

      sessionManager.updateActivity(sessionId);
      const hasMore = truncated;
      const nextCursor = hasMore
        ? { strategy: 'increase_max_entries', suggestedMaxEntries: Math.min((limit || 50) * 2, 1000) }
        : null;
      const topIssues = summarizeConsoleIssues(logs);
      return textResult({ logs, truncated, topIssues, hasMore, nextCursor }, 'get_console_logs');
    })
  );

  // ===== upload_file =====
  server.tool(
    'upload_file',
    '上传文件到 file input 元素（仅 local 模式可用）',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      element_id: z.string().describe('file input 元素的语义ID'),
      filePath: z.string().describe('要上传的文件路径'),
    },
    safe(async ({ sessionId: rawSessionId, element_id, filePath: rawPath }) => {
      if (isRemote) {
        return errorResult('upload_file is disabled in remote mode', ErrorCode.INVALID_PARAMETER);
      }
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);

      const resolvedPath = path.resolve(rawPath);
      // Security check: file must exist and be a regular file (not symlink)
      try {
        const lstat = fs.lstatSync(resolvedPath);
        if (lstat.isSymbolicLink()) {
          throw new Error(`Symbolic links are not allowed: ${resolvedPath}`);
        }
        if (!lstat.isFile()) {
          throw new Error(`Not a regular file: ${resolvedPath}`);
        }
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          throw new Error(`File not found: ${resolvedPath}`);
        }
        throw err;
      }

      const selector = `[data-semantic-id="${escapeCSS(element_id)}"]`;
      const elementHandle = await tab.page.$(selector);
      if (!elementHandle) {
        const err = new Error(`Element not found: ${element_id}`);
        (err as any).errorCode = ErrorCode.ELEMENT_NOT_FOUND;
        throw err;
      }

      await (elementHandle as any).uploadFile(resolvedPath);
      sessionManager.updateActivity(sessionId);
      return textResult({ success: true, filePath: resolvedPath }, 'upload_file');
    })
  );

  // ===== get_downloads =====
  server.tool(
    'get_downloads',
    '获取当前页面的下载文件列表',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
    },
    safe(async ({ sessionId: rawSessionId }) => {
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      if (!tab.events) {
        return textResult({ downloads: [], hasMore: false, nextCursor: null }, 'get_downloads');
      }
      sessionManager.updateActivity(sessionId);
      return textResult({ downloads: tab.events.getDownloads(), hasMore: false, nextCursor: null }, 'get_downloads');
    })
  );

  // ===== Composite Tools =====

  // fill_form: fill multiple form fields and optionally submit
  server.tool(
    'fill_form',
    '一次填写多个表单字段并可选提交。减少多次 type_text 调用',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      fields: z.array(z.object({
        element_id: z.string().describe('输入框的语义ID'),
        value: z.string().describe('要输入的值'),
      })).describe('要填写的字段列表'),
      submit: z.object({
        element_id: z.string().optional().describe('提交按钮的语义ID'),
        pressEnter: z.boolean().optional().describe('是否按回车提交'),
      }).optional().describe('提交方式'),
    },
    safe(async ({ sessionId: rawSessionId, fields, submit }) => {
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      const results: Array<{ element_id: string; success: boolean; error?: string }> = [];

      for (const field of fields) {
        try {
          await executeAction(tab.page, 'type', field.element_id, field.value);
          results.push({ element_id: field.element_id, success: true });
        } catch (err: any) {
          results.push({ element_id: field.element_id, success: false, error: err.message });
        }
      }

      let submitResult: { success: boolean; error?: string } | undefined;
      if (submit) {
        try {
          if (submit.element_id) {
            await executeAction(tab.page, 'click', submit.element_id);
            await new Promise(r => setTimeout(r, 200));
          } else if (submit.pressEnter) {
            await Promise.all([
              tab.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {}),
              tab.page.keyboard.press('Enter'),
            ]);
          }
          submitResult = { success: true };
        } catch (err: any) {
          submitResult = { success: false, error: err.message };
        }
      }

      await saveCookiesFromPage(tab.page);
      sessionManager.updateActivity(sessionId);
      return textResult({
        fieldResults: results,
        submitResult,
        page: { url: tab.page.url(), title: await tab.page.title() },
      }, 'fill_form');
    })
  );

  // click_and_wait: click then auto-wait for stability/navigation
  server.tool(
    'click_and_wait',
    '点击元素后自动等待页面稳定或导航完成',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      element_id: z.string().describe('要点击的元素的语义ID'),
      waitFor: z.string().optional().describe('等待条件: stable(默认) / navigation / selector'),
      selector: z.string().optional().describe('当 waitFor=selector 时，等待此CSS选择器出现'),
    },
    safe(async ({ sessionId: rawSessionId, element_id, waitFor, selector }) => {
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      const waitType = waitFor || 'stable';
      if (!['stable', 'navigation', 'selector'].includes(waitType)) {
        throw invalidParameterError(`Invalid waitFor value: ${waitType}. Must be stable, navigation, or selector`);
      }
      if (waitType === 'selector' && !selector) {
        throw invalidParameterError('selector parameter is required when waitFor=selector');
      }

      // Click
      await executeAction(tab.page, 'click', element_id);
      await new Promise(r => setTimeout(r, 200));

      // Wait
      let waitResult: { stable: boolean; method: string } = { stable: true, method: waitType };
      try {
        if (waitType === 'navigation') {
          await tab.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 });
        } else if (waitType === 'selector' && selector) {
          await tab.page.waitForSelector(selector, { timeout: 10000 });
        } else {
          // stable: wait for network idle + DOM quiet
          await tab.page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
        }
      } catch {
        waitResult.stable = false;
      }

      tab.url = tab.page.url();
      await saveCookiesFromPage(tab.page);

      // Check for popups
      let newTabCreated: string | undefined;
      if (tab.events) {
        const popups = tab.events.getPopupPages();
        for (const popupPage of popups) {
          const newTab = await sessionManager.registerPopupAsTab(sessionId, popupPage);
          if (newTab) newTabCreated = newTab.id;
        }
        tab.events.clearPopupPages();
      }

      sessionManager.updateActivity(sessionId);
      const result: any = {
        success: true,
        waitResult,
        page: { url: tab.page.url(), title: await tab.page.title() },
      };
      if (newTabCreated) result.newTabCreated = newTabCreated;
      if (tab.events) {
        const pending = tab.events.getPendingDialog();
        if (pending) result.dialog = pending;
      }
      return textResult(result, 'click_and_wait');
    })
  );

  // navigate_and_extract: navigate then immediately extract content
  server.tool(
    'navigate_and_extract',
    '导航到URL后立即提取内容，减少两次独立调用',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      url: z.string().describe('要导航到的URL'),
      extract: z.string().optional().describe('提取类型: content(默认) / elements / both'),
    },
    safe(async ({ sessionId: rawSessionId, url, extract }) => {
      const sessionId = await resolveSession(rawSessionId);
      const extractType = extract || 'content';
      if (!['content', 'elements', 'both'].includes(extractType)) {
        throw invalidParameterError(`Invalid extract value: ${extractType}. Must be content, elements, or both`);
      }

      // Navigate
      const navResult = await toolActions.navigate(toolCtx, sessionId, url);
      const tab = getActiveTab(sessionId);

      const result: any = { navigation: navResult };

      // Extract based on type
      if (extractType === 'content' || extractType === 'both') {
        result.content = await toolActions.getPageContent(toolCtx, sessionId, tab.id, {});
      }
      if (extractType === 'elements' || extractType === 'both') {
        result.elements = await toolActions.getPageInfo(toolCtx, sessionId, tab.id, {});
      }

      return textResult(result, 'navigate_and_extract');
    })
  );

  // ===== Memory Tools =====
  const knowledgeStore = options?.knowledgeStore;
  if (knowledgeStore) {
    server.tool(
      'recall_site_memory',
      '查询站点记忆。在调用 navigate 或 navigate_and_extract 进入新域名之前，先调用此工具获取该站点的历史经验（已知选择器、导航路径、操作流程等）。如果没有记忆则返回空，你需要自行探索。',
      {
        domain: z.string().optional().describe('目标站点域名，如 bilibili.com、jd.com'),
        url: z.string().optional().describe('目标 URL（可选），自动提取域名'),
        task_hint: z.string().optional().describe('当前要执行的任务简述（可选），用于筛选最相关的记忆条目'),
      },
      safe(async ({ domain, url, task_hint }: { domain?: string; url?: string; task_hint?: string }) => {
        if (!domain && !url) {
          throw invalidParameterError('domain or url is required');
        }

        let resolvedDomain: string | null = null;
        if (url) {
          resolvedDomain = MemoryCapturer.extractDomain(url);
        } else if (domain) {
          if (isSafeDomain(domain)) resolvedDomain = domain;
        }

        if (!resolvedDomain) {
          throw invalidParameterError('Could not resolve a valid domain from the provided input');
        }

        const card = knowledgeStore.loadCard(resolvedDomain);
        if (!card) {
          return textResult({
            found: false,
            domain: resolvedDomain,
            aiSummary: `没有 ${resolvedDomain} 的站点记忆。请自行探索页面结构。`,
            aiHints: ['使用 get_page_info 探索页面结构', '使用 get_page_content 获取页面内容'],
          }, 'recall_site_memory');
        }

        const truncatedHint = task_hint ? task_hint.slice(0, 200) : undefined;
        const context = MemoryInjector.buildContext(card, 2000, truncatedHint);
        const patternTypes = MemoryInjector.countPatternTypes(card.patterns);
        const patternCount = card.patterns.length;

        return textResult({
          found: true,
          domain: resolvedDomain,
          siteType: card.siteType || 'unknown',
          requiresLogin: card.requiresLogin || false,
          patternCount,
          patternTypes,
          context,
          aiSummary: `已找到 ${resolvedDomain} 的站点记忆（${patternCount} 条模式：${Object.entries(patternTypes).map(([k, v]) => `${v} ${k}`).join(', ')}）。请参考历史经验操作，如页面结构已变化请忽略。`,
        }, 'recall_site_memory');
      })
    );
  }

  // ===== Task Template Tools (delegated to task-tools.ts) =====
  registerTaskTools(server, toolCtx, runManager, artifactStore, isRemote, safe, resolveSession, createIsolatedSession);

  return server;
}
