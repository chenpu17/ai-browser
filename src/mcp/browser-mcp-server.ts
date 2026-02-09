import path from 'node:path';
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SessionManager } from '../browser/index.js';
import { CookieStore } from '../browser/CookieStore.js';
import { executeAction, escapeCSS, setValueByAccessibility } from '../browser/actions.js';
import { validateUrl, type ValidateUrlOptions } from '../utils/url-validator.js';
import {
  ElementCollector,
  PageAnalyzer,
  RegionDetector,
  ContentExtractor,
  ElementMatcher,
} from '../semantic/index.js';

// Structured error codes for Agent consumption
export enum ErrorCode {
  ELEMENT_NOT_FOUND = 'ELEMENT_NOT_FOUND',
  NAVIGATION_TIMEOUT = 'NAVIGATION_TIMEOUT',
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  PAGE_CRASHED = 'PAGE_CRASHED',
  INVALID_PARAMETER = 'INVALID_PARAMETER',
  EXECUTION_ERROR = 'EXECUTION_ERROR',
}

export interface BrowserMcpServerOptions {
  headless?: boolean | 'new';
  /** URL 校验选项，控制 file: 协议和私网地址访问 */
  urlValidation?: ValidateUrlOptions;
}

export function createBrowserMcpServer(sessionManager: SessionManager, cookieStore?: CookieStore, options?: BrowserMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: 'browser-mcp-server', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  const elementCollector = new ElementCollector();
  const pageAnalyzer = new PageAnalyzer();
  const regionDetector = new RegionDetector();
  const contentExtractor = new ContentExtractor();
  const elementMatcher = new ElementMatcher();

  /** Save all cookies from a page via CDP (includes cross-domain SSO cookies) */
  async function saveCookiesFromPage(page: import('puppeteer').Page): Promise<void> {
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
  async function injectCookiesToPage(page: import('puppeteer').Page): Promise<void> {
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
        const sessionOpts = options?.headless !== undefined ? { headless: options.headless } : {};
        const session = await sessionManager.create(sessionOpts);
        defaultSessionId = session.id;
        defaultSessionPromise = null;
        return session.id;
      })();
    }
    return defaultSessionPromise;
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
  function textResult(data: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
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
      return textResult({ sessionId: session.id });
    })
  );

  server.tool(
    'close_session',
    '关闭浏览器会话',
    { sessionId: z.string().optional().describe('会话ID，不传则使用默认会话') },
    safe(async ({ sessionId: rawSessionId }) => {
      const sessionId = await resolveSession(rawSessionId);
      // 关闭前保存当前会话 + 所有 headful 会话的 cookie
      await sessionManager.saveAllCookies(sessionId);

      // headful 会话不自动关闭，保留给用户手动操作
      const session = sessionManager.get(sessionId);
      if (session && !session.headless) {
        return textResult({ success: true, kept: true, reason: 'headful session preserved' });
      }

      const closed = await sessionManager.close(sessionId);
      // Clear default session if it was closed
      if (sessionId === defaultSessionId) {
        defaultSessionId = null;
      }
      return textResult({ success: closed });
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
      // URL validation
      const check = validateUrl(url, options?.urlValidation ?? {});
      if (!check.valid) {
        const err = new Error(check.reason);
        (err as any).errorCode = ErrorCode.INVALID_PARAMETER;
        throw err;
      }

      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      // 导航前先从 headful 会话同步最新 cookie（用户可能手动登录了）
      await sessionManager.syncHeadfulCookies();
      // 注入已保存的 cookies（通过 CDP 注入全部 cookie，支持跨域 SSO）
      await injectCookiesToPage(tab.page);
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
      // 给 SPA 页面额外渲染时间
      try {
        await tab.page.waitForNetworkIdle({ timeout: 3000 });
      } catch {
        // 忽略超时，不阻塞
      }
      tab.url = tab.page.url();
      await saveCookiesFromPage(tab.page);
      sessionManager.updateActivity(sessionId);
      let title = '';
      try { title = await tab.page.title(); } catch { title = '(无法获取标题)'; }
      const result: any = {
        success: true,
        partial,
        statusCode,
        page: { url: tab.page.url(), title },
      };
      // Check for pending dialog after navigation
      if (tab.events) {
        const pending = tab.events.getPendingDialog();
        if (pending) result.dialog = pending;
      }
      return textResult(result);
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
      const limit = maxElements ?? 50;
      const filterVisible = visibleOnly ?? true;

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
            if (!b || (b.width === 0 && b.height === 0)) return true; // keep elements without bounds
            return b.y + b.height > 0 && b.y < viewport.height && b.x + b.width > 0 && b.x < viewport.width;
          });
        }
      }

      // Sort by y position and truncate
      const totalElements = filtered.length;
      filtered.sort((a: any, b: any) => (a.bounds?.y ?? 0) - (b.bounds?.y ?? 0));
      const truncated = filtered.length > limit;
      if (truncated) {
        filtered = filtered.slice(0, limit);
      }

      // Mask sensitive field values
      for (const el of filtered as any[]) {
        if (el.type === 'textbox' || el.type === 'input') {
          const idLower = (el.id || '').toLowerCase();
          const labelLower = (el.label || '').toLowerCase();
          const isPassword = idLower.includes('password') || idLower.includes('secret') || idLower.includes('token')
            || labelLower.includes('password') || labelLower.includes('secret') || labelLower.includes('token');
          if (isPassword && el.state?.value) {
            el.state.value = '********';
          }
        }
      }

      sessionManager.updateActivity(sessionId);
      const result: any = {
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
      };
      // Add stability and dialog info from PageEventTracker
      if (tab.events) {
        result.stability = tab.events.getStabilityState();
        const pending = tab.events.getPendingDialog();
        if (pending) result.pendingDialog = pending;
      }
      return textResult(result);
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
      const content = await contentExtractor.extract(tab.page);
      // Truncate sections if maxLength specified
      if (maxLength && content.sections) {
        let totalLen = 0;
        const truncatedSections: typeof content.sections = [];
        for (const section of content.sections) {
          const sectionText = section.text || '';
          if (totalLen + sectionText.length > maxLength) {
            const remaining = maxLength - totalLen;
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
      sessionManager.updateActivity(sessionId);
      return textResult(content);
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
      return textResult(result);
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
      });
    })
  );

  // ===== scroll =====
  server.tool(
    'scroll',
    '滚动页面',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      direction: z.enum(['down', 'up']).describe('滚动方向'),
    },
    safe(async ({ sessionId: rawSessionId, direction }) => {
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      await executeAction(tab.page, 'scroll', undefined, direction);
      sessionManager.updateActivity(sessionId);
      return textResult({ success: true });
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
      modifiers: z.array(z.enum(['Control', 'Shift', 'Alt', 'Meta'])).optional().describe('修饰键数组，如 ["Control"] 表示 Ctrl+key'),
    },
    safe(async ({ sessionId: rawSessionId, key, modifiers }) => {
      if (modifiers && modifiers.length > 0) {
        // Combo key mode
        if (!isComboAllowed(modifiers, key)) {
          throw new Error(`不允许的组合键: ${modifiers.join('+')}+${key}`);
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
        });
      }
      // Single key mode (original logic)
      if (!ALLOWED_KEYS.has(key)) {
        throw new Error(`不允许的按键: ${key}。允许: ${[...ALLOWED_KEYS].join(', ')}`);
      }
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      await tab.page.keyboard.press(key);
      await new Promise(r => setTimeout(r, 300));
      sessionManager.updateActivity(sessionId);
      return textResult({
        success: true,
        page: { url: tab.page.url(), title: await tab.page.title() },
      });
    })
  );

  // ===== go_back =====
  server.tool(
    'go_back',
    '返回上一页',
    { sessionId: z.string().optional().describe('会话ID，不传则使用默认会话') },
    safe(async ({ sessionId: rawSessionId }) => {
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      await executeAction(tab.page, 'back');
      tab.url = tab.page.url();
      sessionManager.updateActivity(sessionId);
      return textResult({
        success: true,
        page: { url: tab.page.url(), title: await tab.page.title() },
      });
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
      });
    })
  );

  // ===== wait =====
  server.tool(
    'wait',
    '等待页面加载',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      milliseconds: z.number().optional().describe('等待的毫秒数，默认1000'),
      selector: z.string().optional().describe('等待指定CSS选择器的元素出现'),
      condition: z.enum(['time', 'selector', 'networkidle', 'element_hidden']).optional().describe('等待条件类型'),
    },
    safe(async ({ sessionId: rawSessionId, milliseconds, selector, condition }) => {
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      // For condition-based waits, default timeout is 10s; for simple time wait, default is 1s
      if (condition === 'networkidle') {
        await tab.page.waitForNetworkIdle({ timeout: milliseconds || 10000 });
      } else if (condition === 'element_hidden') {
        if (!selector) throw new Error('selector is required for element_hidden condition');
        await tab.page.waitForSelector(selector, { hidden: true, timeout: milliseconds || 10000 });
      } else if (condition === 'selector' || (!condition && selector)) {
        if (!selector) throw new Error('selector is required for selector condition');
        await tab.page.waitForSelector(selector, { timeout: milliseconds || 10000 });
      } else {
        await new Promise(r => setTimeout(r, Math.min(milliseconds || 1000, 30000)));
      }

      sessionManager.updateActivity(sessionId);
      return textResult({ success: true });
    })
  );

  // ===== execute_javascript =====
  server.tool(
    'execute_javascript',
    '在当前页面执行 JavaScript 脚本。脚本必须通过表达式或 return 返回数据，console.log 的输出不会返回',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      script: z.string().describe('要执行的 JavaScript 代码'),
    },
    safe(async ({ sessionId: rawSessionId, script }) => {
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
        return textResult({ result: null, hint: '脚本无返回值。如需获取数据，请在脚本末尾使用表达式（如 document.title）或 return 语句。console.log 的输出不会返回。' });
      }
      let serialized = JSON.stringify(result);
      const truncated = serialized && serialized.length > 4000;
      if (truncated) {
        serialized = serialized.slice(0, 4000) + '...(truncated)';
      }
      return textResult({ result: truncated ? serialized : result, truncated });
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
      return textResult({ success: true });
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
      return textResult({ success: true });
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
      const closed = await sessionManager.closeTab(sessionId, tabId);
      if (!closed) throw new Error(`Tab not found: ${tabId}`);
      sessionManager.updateActivity(sessionId);
      return textResult({ success: true });
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
      const tab = sessionManager.getActiveTab(sessionId)!;
      return textResult({
        success: true,
        page: { url: tab.page.url(), title: await tab.page.title() },
      });
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
      const tab = await sessionManager.createTab(sessionId);
      if (!tab) throw new Error(`Session not found: ${sessionId}`);
      // Auto-switch to the new tab
      sessionManager.switchTab(sessionId, tab.id);
      let partial = false;
      if (url) {
        const check = validateUrl(url, options?.urlValidation ?? {});
        if (!check.valid) {
          const err = new Error(check.reason);
          (err as any).errorCode = ErrorCode.INVALID_PARAMETER;
          throw err;
        }
        // Inject saved cookies before navigation (consistent with navigate tool)
        await injectCookiesToPage(tab.page);
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
        // Save cookies after navigation
        await saveCookiesFromPage(tab.page);
      }
      sessionManager.updateActivity(sessionId);
      return textResult({ tabId: tab.id, url: tab.page.url(), partial });
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
      return textResult({
        activeTabId: session.activeTabId,
        tabs: await Promise.all(tabs.map(async (t) => {
          let title = '';
          try { title = await t.page.title(); } catch {}
          return { id: t.id, url: t.page.url(), title };
        })),
      });
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
      format: z.enum(['png', 'jpeg', 'webp']).optional().describe('截图格式，默认 png'),
      quality: z.number().min(0).max(100).optional().describe('图片质量（仅 jpeg/webp 有效），默认 80'),
    },
    safe(async ({ sessionId: rawSessionId, fullPage, element_id, format, quality }) => {
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);

      const imgFormat = format || 'png';
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
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ captured: true, url: pageUrl, title: pageTitle, fullPage: !!fullPage, element: element_id || null }) },
          { type: 'image' as const, data: base64, mimeType },
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
      return textResult({ success: true });
    })
  );

  // ===== handle_dialog =====
  server.tool(
    'handle_dialog',
    '处理页面弹窗（alert/confirm/prompt），接受或拒绝',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      action: z.enum(['accept', 'dismiss']).describe('accept 接受弹窗，dismiss 拒绝弹窗'),
      text: z.string().optional().describe('为 prompt 弹窗提供输入文本'),
    },
    safe(async ({ sessionId: rawSessionId, action, text }) => {
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      if (!tab.events) {
        return textResult({ success: false, reason: 'Event tracking not available' });
      }
      const pending = tab.events.getPendingDialog();
      if (!pending) {
        return textResult({ success: false, reason: 'No pending dialog' });
      }
      await tab.events.handleDialog(action, text);
      sessionManager.updateActivity(sessionId);
      return textResult({ success: true, dialog: pending });
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
        return textResult({ pendingDialog: null, dialogHistory: [] });
      }
      sessionManager.updateActivity(sessionId);
      return textResult({
        pendingDialog: tab.events.getPendingDialog(),
        dialogHistory: tab.events.getDialogs(),
      });
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
      if (!tab.events) {
        return textResult({ stable: true, domStable: true, networkPending: 0, loadState: 'loaded' });
      }
      const maxWait = Math.min(timeout ?? 5000, 30000);
      const stable = await tab.events.waitForStable(maxWait, quietMs);
      sessionManager.updateActivity(sessionId);
      const state = tab.events.getStabilityState();
      return textResult({ ...state, stable });
    })
  );

  // ===== get_network_logs =====
  server.tool(
    'get_network_logs',
    '获取页面网络请求日志',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      filter: z.enum(['all', 'xhr', 'failed', 'slow']).optional().describe('过滤类型：all=全部, xhr=仅XHR/Fetch, failed=仅失败, slow=慢请求(>1s)'),
      maxEntries: z.number().optional().describe('最大返回条数，默认50'),
      includeHeaders: z.boolean().optional().describe('是否包含请求/响应头，默认false'),
      urlPattern: z.string().optional().describe('URL 匹配模式（子串匹配）'),
    },
    safe(async ({ sessionId: rawSessionId, filter, maxEntries, includeHeaders, urlPattern }) => {
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      if (!tab.events) {
        return textResult({ logs: [], totalCount: 0, truncated: false });
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
      return textResult({ logs, totalCount, truncated });
    })
  );

  // ===== get_console_logs =====
  server.tool(
    'get_console_logs',
    '获取页面控制台日志',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      level: z.enum(['error', 'warn', 'log', 'info', 'debug', 'all']).optional().describe('日志级别过滤，默认只返回 error+warn'),
      maxEntries: z.number().optional().describe('最大返回条数，默认50'),
    },
    safe(async ({ sessionId: rawSessionId, level, maxEntries }) => {
      const sessionId = await resolveSession(rawSessionId);
      const tab = getActiveTab(sessionId);
      if (!tab.events) {
        return textResult({ logs: [], truncated: false });
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
      return textResult({ logs, truncated });
    })
  );

  // ===== upload_file =====
  server.tool(
    'upload_file',
    '上传文件到 file input 元素',
    {
      sessionId: z.string().optional().describe('会话ID，不传则使用默认会话'),
      element_id: z.string().describe('file input 元素的语义ID'),
      filePath: z.string().describe('要上传的文件路径'),
    },
    safe(async ({ sessionId: rawSessionId, element_id, filePath: rawPath }) => {
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
      return textResult({ success: true, filePath: resolvedPath });
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
        return textResult({ downloads: [] });
      }
      sessionManager.updateActivity(sessionId);
      return textResult({ downloads: tab.events.getDownloads() });
    })
  );

  return server;
}
