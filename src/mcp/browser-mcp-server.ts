import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SessionManager } from '../browser/index.js';
import { CookieStore } from '../browser/CookieStore.js';
import { executeAction } from '../browser/actions.js';
import {
  ElementCollector,
  PageAnalyzer,
  RegionDetector,
  ContentExtractor,
  ElementMatcher,
} from '../semantic/index.js';

export interface BrowserMcpServerOptions {
  headless?: boolean | 'new';
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

  // Helper: get active tab for a session
  function getActiveTab(sessionId: string) {
    const tab = sessionManager.getActiveTab(sessionId);
    if (!tab) throw new Error(`Session or active tab not found: ${sessionId}`);
    return tab;
  }

  // Helper: wrap result as MCP text content
  function textResult(data: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
  }

  // Helper: wrap error as MCP error content
  function errorResult(message: string) {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true as const };
  }

  // Helper: wrap async handler with try/catch to prevent unhandled exceptions
  function safe<T extends (...args: any[]) => Promise<any>>(fn: T): T {
    return (async (...args: any[]) => {
      try {
        return await fn(...args);
      } catch (err: any) {
        return errorResult(err.message || 'Unknown error');
      }
    }) as T;
  }

  // create_session / close_session 不再注册为 MCP tool
  // Agent loop 自动管理 session 生命周期，暴露给 LLM 会导致重复创建和误关闭
  // 保留为内部函数供 Agent loop 直接调用

  server.tool(
    'create_session',
    '(内部工具，请勿调用)',
    {},
    safe(async () => {
      const sessionOpts = options?.headless !== undefined ? { headless: options.headless } : {};
      const session = await sessionManager.create(sessionOpts);
      return textResult({ sessionId: session.id });
    })
  );

  server.tool(
    'close_session',
    '(内部工具，请勿调用)',
    { sessionId: z.string().describe('会话ID') },
    safe(async ({ sessionId }) => {
      const closed = await sessionManager.close(sessionId);
      return textResult({ success: closed });
    })
  );

  // ===== navigate =====
  server.tool(
    'navigate',
    '导航到指定URL',
    {
      sessionId: z.string().describe('会话ID'),
      url: z.string().describe('要导航到的完整URL'),
    },
    safe(async ({ sessionId, url }) => {
      // URL validation
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        throw new Error('Invalid URL format');
      }
      const allowedProtocols = ['http:', 'https:', 'file:'];
      if (!allowedProtocols.includes(parsedUrl.protocol)) {
        throw new Error('Only http/https/file URLs allowed');
      }

      const tab = getActiveTab(sessionId);
      // 导航前注入已保存的 cookies
      if (cookieStore) {
        const savedCookies = cookieStore.getForUrl(url);
        if (savedCookies.length > 0) {
          await tab.page.setCookie(...savedCookies as any[]);
        }
      }
      let partial = false;
      try {
        await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (err: any) {
        if (err.name === 'TimeoutError' || err.message?.includes('timeout')) {
          // 超时降级：页面可能已部分加载，允许 Agent 继续操作
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
      // 导航后保存 cookies
      if (cookieStore) {
        try {
          const cookies = await tab.page.cookies();
          cookieStore.save(tab.page.url(), cookies as any[]);
        } catch {}
      }
      sessionManager.updateActivity(sessionId);
      let title = '';
      try { title = await tab.page.title(); } catch { title = '(无法获取标题)'; }
      return textResult({
        success: true,
        partial,
        page: { url: tab.page.url(), title },
      });
    })
  );

  // ===== get_page_info =====
  server.tool(
    'get_page_info',
    '获取当前页面的语义信息，包括可交互元素列表',
    { sessionId: z.string().describe('会话ID') },
    safe(async ({ sessionId }) => {
      const tab = getActiveTab(sessionId);
      const [elements, analysis, regions] = await Promise.all([
        elementCollector.collect(tab.page),
        pageAnalyzer.analyze(tab.page),
        regionDetector.detect(tab.page),
      ]);
      sessionManager.updateActivity(sessionId);
      return textResult({
        page: {
          url: tab.page.url(),
          title: await tab.page.title(),
          type: analysis.pageType,
          summary: analysis.summary,
        },
        elements,
        regions,
        intents: analysis.intents,
      });
    })
  );

  // ===== get_page_content =====
  server.tool(
    'get_page_content',
    '提取当前页面的文本内容',
    { sessionId: z.string().describe('会话ID') },
    safe(async ({ sessionId }) => {
      const tab = getActiveTab(sessionId);
      const content = await contentExtractor.extract(tab.page);
      sessionManager.updateActivity(sessionId);
      return textResult(content);
    })
  );

  // ===== click =====
  server.tool(
    'click',
    '点击页面上的元素',
    {
      sessionId: z.string().describe('会话ID'),
      element_id: z.string().describe('要点击的元素的语义ID'),
    },
    safe(async ({ sessionId, element_id }) => {
      const tab = getActiveTab(sessionId);
      await executeAction(tab.page, 'click', element_id);
      tab.url = tab.page.url();
      if (cookieStore) {
        try {
          const cookies = await tab.page.cookies();
          cookieStore.save(tab.page.url(), cookies as any[]);
        } catch {}
      }
      sessionManager.updateActivity(sessionId);
      return textResult({
        success: true,
        page: { url: tab.page.url(), title: await tab.page.title() },
      });
    })
  );

  // ===== type_text =====
  server.tool(
    'type_text',
    '在输入框中输入文本。设置 submit=true 可在输入后自动按回车提交（适用于搜索框）',
    {
      sessionId: z.string().describe('会话ID'),
      element_id: z.string().describe('输入框的语义ID'),
      text: z.string().describe('要输入的文本内容'),
      submit: z.boolean().optional().describe('输入后是否按回车提交，默认 false'),
    },
    safe(async ({ sessionId, element_id, text, submit }) => {
      const tab = getActiveTab(sessionId);
      await executeAction(tab.page, 'type', element_id, text);
      if (submit) {
        await Promise.all([
          tab.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {}),
          tab.page.keyboard.press('Enter'),
        ]);
      }
      if (cookieStore) {
        try {
          const cookies = await tab.page.cookies();
          cookieStore.save(tab.page.url(), cookies as any[]);
        } catch {}
      }
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
      sessionId: z.string().describe('会话ID'),
      direction: z.enum(['down', 'up']).describe('滚动方向'),
    },
    safe(async ({ sessionId, direction }) => {
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

  server.tool(
    'press_key',
    '按下键盘按键（如 Enter, Escape, Tab, ArrowDown 等）',
    {
      sessionId: z.string().describe('会话ID'),
      key: z.string().describe('按键名称，如 Enter, Escape, Tab, ArrowDown, ArrowUp'),
    },
    safe(async ({ sessionId, key }) => {
      if (!ALLOWED_KEYS.has(key)) {
        throw new Error(`不允许的按键: ${key}。允许: ${[...ALLOWED_KEYS].join(', ')}`);
      }
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
    { sessionId: z.string().describe('会话ID') },
    safe(async ({ sessionId }) => {
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
      sessionId: z.string().describe('会话ID'),
      query: z.string().describe('用自然语言描述要查找的元素'),
    },
    safe(async ({ sessionId, query }) => {
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
      sessionId: z.string().describe('会话ID'),
      milliseconds: z.number().optional().describe('等待的毫秒数，默认1000'),
      selector: z.string().optional().describe('等待指定CSS选择器的元素出现'),
    },
    safe(async ({ sessionId, milliseconds, selector }) => {
      const tab = getActiveTab(sessionId);
      if (selector) {
        await tab.page.waitForSelector(selector, { timeout: milliseconds || 10000 });
      } else {
        await new Promise(r => setTimeout(r, Math.min(milliseconds || 1000, 30000)));
      }
      sessionManager.updateActivity(sessionId);
      return textResult({ success: true });
    })
  );

  return server;
}
