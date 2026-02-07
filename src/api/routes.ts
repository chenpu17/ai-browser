import { randomUUID } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { SessionManager } from '../browser/index.js';
import { executeAction } from '../browser/actions.js';
import {
  ElementCollector,
  PageAnalyzer,
  RegionDetector,
  ContentExtractor,
  IframeHandler,
  ElementMatcher,
} from '../semantic/index.js';
import { ApiError, ErrorCode } from './errors.js';
import { BrowsingAgent } from '../agent/agent-loop.js';
import { createBrowserMcpServer } from '../mcp/browser-mcp-server.js';
import { CookieStore } from '../browser/CookieStore.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const MAX_BATCH_ACTIONS = 50;

export function registerRoutes(
  app: FastifyInstance,
  sessionManager: SessionManager
) {
  const elementCollector = new ElementCollector();
  const pageAnalyzer = new PageAnalyzer();
  const regionDetector = new RegionDetector();
  const contentExtractor = new ContentExtractor();
  const iframeHandler = new IframeHandler();
  const elementMatcher = new ElementMatcher();

  // 健康检查
  app.get('/health', async () => {
    return { status: 'healthy', version: '0.1.0' };
  });

  // 内存使用情况（用于测试监控）
  app.get('/v1/memory', async () => {
    const mem = process.memoryUsage();
    return {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
    };
  });

  // 服务信息
  app.get('/v1/info', async () => {
    return {
      version: '0.1.0',
      capabilities: ['semantic', 'action'],
    };
  });

  // 创建会话
  app.post('/v1/sessions', async (request) => {
    const { options } = request.body as any || {};
    const session = await sessionManager.create(options);
    return {
      sessionId: session.id,
      status: 'created',
    };
  });

  // 获取会话详情
  app.get('/v1/sessions/:sessionId', async (request) => {
    const { sessionId } = request.params as any;
    const session = sessionManager.get(sessionId);
    if (!session) {
      throw new ApiError(ErrorCode.SESSION_NOT_FOUND, 'Session not found', 404);
    }
    const tabs = sessionManager.listTabs(sessionId);
    return {
      sessionId: session.id,
      status: 'active',
      activeTabId: session.activeTabId,
      tabs: tabs.map(t => ({ id: t.id, url: t.url })),
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      expiresAt: session.expiresAt,
    };
  });

  // 关闭会话
  app.delete('/v1/sessions/:sessionId', async (request) => {
    const { sessionId } = request.params as any;
    const closed = await sessionManager.close(sessionId);
    if (!closed) {
      throw new ApiError(ErrorCode.SESSION_NOT_FOUND, 'Session not found', 404);
    }
    return { success: true };
  });

  // ========== Tab管理API ==========

  // 创建新Tab
  app.post('/v1/sessions/:sessionId/tabs', async (request) => {
    const { sessionId } = request.params as any;
    const { url } = request.body as any;

    const session = sessionManager.get(sessionId);
    if (!session) {
      throw new ApiError(ErrorCode.SESSION_NOT_FOUND, 'Session not found', 404);
    }

    // URL验证（如果提供了URL）
    if (url) {
      if (typeof url !== 'string') {
        throw new ApiError(ErrorCode.INVALID_REQUEST, 'URL must be a string', 400);
      }
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        throw new ApiError(ErrorCode.INVALID_REQUEST, 'Invalid URL format', 400);
      }
      const allowedProtocols = ['http:', 'https:', 'file:'];
      if (!allowedProtocols.includes(parsedUrl.protocol)) {
        throw new ApiError(ErrorCode.INVALID_REQUEST, 'Only http/https/file URLs allowed', 400);
      }
    }

    let tab;
    try {
      tab = await sessionManager.createTab(sessionId);
    } catch (err: any) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, err.message, 400);
    }
    if (!tab) {
      throw new ApiError(ErrorCode.INTERNAL_ERROR, 'Failed to create tab', 500);
    }

    // 如果提供了URL，直接导航
    if (url) {
      await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      tab.url = tab.page.url();
    }

    return {
      tabId: tab.id,
      url: tab.url,
      title: await tab.page.title(),
    };
  });

  // 列出所有Tab
  app.get('/v1/sessions/:sessionId/tabs', async (request) => {
    const { sessionId } = request.params as any;
    const session = sessionManager.get(sessionId);
    if (!session) {
      throw new ApiError(ErrorCode.SESSION_NOT_FOUND, 'Session not found', 404);
    }

    const tabs = sessionManager.listTabs(sessionId);
    const tabInfos = await Promise.all(tabs.map(async t => ({
      id: t.id,
      url: t.page.url(),
      title: await t.page.title(),
      isActive: t.id === session.activeTabId,
    })));

    return { tabs: tabInfos, activeTabId: session.activeTabId };
  });

  // 关闭Tab
  app.delete('/v1/sessions/:sessionId/tabs/:tabId', async (request) => {
    const { sessionId, tabId } = request.params as any;
    const closed = await sessionManager.closeTab(sessionId, tabId);
    if (!closed) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Tab not found', 404);
    }
    return { success: true };
  });

  // 切换活动Tab
  app.post('/v1/sessions/:sessionId/tabs/:tabId/activate', async (request) => {
    const { sessionId, tabId } = request.params as any;
    const success = sessionManager.switchTab(sessionId, tabId);
    if (!success) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Tab not found', 404);
    }
    return { success: true, activeTabId: tabId };
  });

  // 页面导航（支持指定tabId）
  app.post('/v1/sessions/:sessionId/navigate', async (request) => {
    const { sessionId } = request.params as any;
    const { url, tabId } = request.body as any;

    // URL验证
    if (!url || typeof url !== 'string') {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'URL is required', 400);
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Invalid URL format', 400);
    }
    const allowedProtocols = ['http:', 'https:', 'file:'];
    if (!allowedProtocols.includes(parsedUrl.protocol)) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Only http/https/file URLs allowed', 400);
    }

    const session = sessionManager.get(sessionId);
    if (!session) {
      throw new ApiError(ErrorCode.SESSION_NOT_FOUND, 'Session not found', 404);
    }

    // 获取目标Tab（默认使用活动Tab）
    const tab = tabId
      ? sessionManager.getTab(sessionId, tabId)
      : sessionManager.getActiveTab(sessionId);
    if (!tab) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Tab not found', 404);
    }

    try {
      await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err: any) {
      if (err.name === 'TimeoutError') {
        throw new ApiError(ErrorCode.PAGE_LOAD_TIMEOUT, `Navigation timeout: ${url}`, 504);
      }
      throw new ApiError(ErrorCode.ACTION_FAILED, err.message || 'Navigation failed', 502);
    }
    tab.url = tab.page.url();
    sessionManager.updateActivity(sessionId);
    return {
      success: true,
      tabId: tab.id,
      page: {
        url: tab.page.url(),
        title: await tab.page.title(),
      },
    };
  });

  // 获取语义元素（支持tabId参数）
  app.get('/v1/sessions/:sessionId/semantic', async (request) => {
    const { sessionId } = request.params as any;
    const { tabId } = request.query as any;

    const session = sessionManager.get(sessionId);
    if (!session) {
      throw new ApiError(ErrorCode.SESSION_NOT_FOUND, 'Session not found', 404);
    }

    const tab = tabId
      ? sessionManager.getTab(sessionId, tabId)
      : sessionManager.getActiveTab(sessionId);
    if (!tab) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Tab not found', 404);
    }

    const [elements, analysis, regions] = await Promise.all([
      elementCollector.collect(tab.page),
      pageAnalyzer.analyze(tab.page),
      regionDetector.detect(tab.page),
    ]);
    sessionManager.updateActivity(sessionId);

    return {
      tabId: tab.id,
      page: {
        url: tab.page.url(),
        title: await tab.page.title(),
        type: analysis.pageType,
        summary: analysis.summary,
      },
      elements,
      regions,
      intents: analysis.intents,
    };
  });

  // 执行操作（支持tabId）
  app.post('/v1/sessions/:sessionId/action', async (request) => {
    const { sessionId } = request.params as any;
    const { action, elementId, value, tabId } = request.body as any;

    if (!action || typeof action !== 'string') {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Action is required', 400);
    }

    const session = sessionManager.get(sessionId);
    if (!session) {
      throw new ApiError(ErrorCode.SESSION_NOT_FOUND, 'Session not found', 404);
    }

    const tab = tabId
      ? sessionManager.getTab(sessionId, tabId)
      : sessionManager.getActiveTab(sessionId);
    if (!tab) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Tab not found', 404);
    }

    try {
      await executeAction(tab.page, action, elementId, value);
      tab.url = tab.page.url();
      sessionManager.updateActivity(sessionId);

      return {
        success: true,
        tabId: tab.id,
        page: {
          url: tab.page.url(),
          title: await tab.page.title(),
        },
      };
    } catch (err: any) {
      throw new ApiError(
        ErrorCode.ACTION_FAILED,
        err.message || 'Action failed',
        400
      );
    }
  });

  // 批量操作（支持tabId）
  app.post('/v1/sessions/:sessionId/actions', async (request) => {
    const { sessionId } = request.params as any;
    const { actions, tabId } = request.body as any;

    if (!Array.isArray(actions) || actions.length === 0) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Actions array required', 400);
    }
    if (actions.length > MAX_BATCH_ACTIONS) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, `Max ${MAX_BATCH_ACTIONS} actions allowed`, 400);
    }

    const session = sessionManager.get(sessionId);
    if (!session) {
      throw new ApiError(ErrorCode.SESSION_NOT_FOUND, 'Session not found', 404);
    }

    const tab = tabId
      ? sessionManager.getTab(sessionId, tabId)
      : sessionManager.getActiveTab(sessionId);
    if (!tab) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Tab not found', 404);
    }

    const results: Array<{ success: boolean; error?: string }> = [];
    for (const act of actions) {
      if (!act || typeof act.action !== 'string') {
        results.push({ success: false, error: 'Invalid action object' });
        continue;
      }
      try {
        await executeAction(tab.page, act.action, act.elementId, act.value);
        results.push({ success: true });
      } catch (err: any) {
        results.push({ success: false, error: err.message });
      }
    }

    tab.url = tab.page.url();
    sessionManager.updateActivity(sessionId);
    return {
      results,
      tabId: tab.id,
      page: {
        url: tab.page.url(),
        title: await tab.page.title(),
      },
    };
  });

  // 内容提取（支持tabId）
  app.get('/v1/sessions/:sessionId/content', async (request) => {
    const { sessionId } = request.params as any;
    const { tabId } = request.query as any;

    const session = sessionManager.get(sessionId);
    if (!session) {
      throw new ApiError(ErrorCode.SESSION_NOT_FOUND, 'Session not found', 404);
    }

    const tab = tabId
      ? sessionManager.getTab(sessionId, tabId)
      : sessionManager.getActiveTab(sessionId);
    if (!tab) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Tab not found', 404);
    }

    const content = await contentExtractor.extract(tab.page);
    sessionManager.updateActivity(sessionId);
    return { tabId: tab.id, ...content };
  });

  // iframe信息（支持tabId）
  app.get('/v1/sessions/:sessionId/frames', async (request) => {
    const { sessionId } = request.params as any;
    const { tabId } = request.query as any;

    const session = sessionManager.get(sessionId);
    if (!session) {
      throw new ApiError(ErrorCode.SESSION_NOT_FOUND, 'Session not found', 404);
    }

    const tab = tabId
      ? sessionManager.getTab(sessionId, tabId)
      : sessionManager.getActiveTab(sessionId);
    if (!tab) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Tab not found', 404);
    }

    const frames = await iframeHandler.detectFrames(tab.page);
    sessionManager.updateActivity(sessionId);
    return { tabId: tab.id, frames };
  });

  // 模糊匹配元素（支持tabId）
  app.post('/v1/sessions/:sessionId/match', async (request) => {
    const { sessionId } = request.params as any;
    const { query, limit, tabId } = request.body as any;

    if (!query) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Query required', 400);
    }

    const session = sessionManager.get(sessionId);
    if (!session) {
      throw new ApiError(ErrorCode.SESSION_NOT_FOUND, 'Session not found', 404);
    }

    const tab = tabId
      ? sessionManager.getTab(sessionId, tabId)
      : sessionManager.getActiveTab(sessionId);
    if (!tab) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Tab not found', 404);
    }

    const elements = await elementCollector.collect(tab.page);
    const candidates = elementMatcher.findByQuery(elements, query, limit || 5);
    sessionManager.updateActivity(sessionId);

    return {
      tabId: tab.id,
      query,
      candidates: candidates.map((c) => ({
        id: c.element.id,
        label: c.element.label,
        type: c.element.type,
        score: c.score,
        matchReason: c.matchReason,
      })),
    };
  });

  // 并发获取多个Tab的内容（AI批量浏览场景）
  app.post('/v1/sessions/:sessionId/tabs/batch-content', async (request) => {
    const { sessionId } = request.params as any;
    const { tabIds } = request.body as any;

    const session = sessionManager.get(sessionId);
    if (!session) {
      throw new ApiError(ErrorCode.SESSION_NOT_FOUND, 'Session not found', 404);
    }

    const tabs = tabIds
      ? tabIds.map((id: string) => sessionManager.getTab(sessionId, id)).filter(Boolean)
      : sessionManager.listTabs(sessionId);

    const results = await Promise.all(tabs.map(async (tab: any) => {
      try {
        const [content, elements] = await Promise.all([
          contentExtractor.extract(tab.page),
          elementCollector.collect(tab.page),
        ]);
        return {
          tabId: tab.id,
          url: tab.page.url(),
          title: await tab.page.title(),
          content,
          elementCount: elements.length,
          success: true,
        };
      } catch (err: any) {
        return {
          tabId: tab.id,
          success: false,
          error: err.message,
        };
      }
    }));

    return { results };
  });

  // 在页面中执行JavaScript（用于精确提取数据）
  app.post('/v1/sessions/:sessionId/evaluate', async (request) => {
    const { sessionId } = request.params as any;
    const { expression, tabId } = request.body as any;

    if (!expression || typeof expression !== 'string') {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Expression is required', 400);
    }

    const session = sessionManager.get(sessionId);
    if (!session) {
      throw new ApiError(ErrorCode.SESSION_NOT_FOUND, 'Session not found', 404);
    }

    const tab = tabId
      ? sessionManager.getTab(sessionId, tabId)
      : sessionManager.getActiveTab(sessionId);
    if (!tab) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Tab not found', 404);
    }

    try {
      const result = await tab.page.evaluate(expression);
      sessionManager.updateActivity(sessionId);
      return { success: true, tabId: tab.id, result };
    } catch (err: any) {
      throw new ApiError(ErrorCode.ACTION_FAILED, err.message || 'Evaluate failed', 400);
    }
  });

  // 等待指定时间（配合动态内容加载）
  app.post('/v1/sessions/:sessionId/wait', async (request) => {
    const { sessionId } = request.params as any;
    const { milliseconds, selector, tabId } = request.body as any;

    const session = sessionManager.get(sessionId);
    if (!session) {
      throw new ApiError(ErrorCode.SESSION_NOT_FOUND, 'Session not found', 404);
    }

    const tab = tabId
      ? sessionManager.getTab(sessionId, tabId)
      : sessionManager.getActiveTab(sessionId);
    if (!tab) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Tab not found', 404);
    }

    try {
      if (selector) {
        await tab.page.waitForSelector(selector, { timeout: milliseconds || 10000 });
      } else {
        await new Promise(r => setTimeout(r, Math.min(milliseconds || 1000, 30000)));
      }
      sessionManager.updateActivity(sessionId);
      return { success: true, tabId: tab.id };
    } catch (err: any) {
      throw new ApiError(ErrorCode.ACTION_FAILED, err.message || 'Wait failed', 400);
    }
  });

  // ========== Screenshot API ==========

  app.get('/v1/sessions/:sessionId/screenshot', async (request) => {
    const { sessionId } = request.params as any;

    const session = sessionManager.get(sessionId);
    if (!session) {
      throw new ApiError(ErrorCode.SESSION_NOT_FOUND, 'Session not found', 404);
    }

    const tab = sessionManager.getActiveTab(sessionId);
    if (!tab) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'No active tab', 404);
    }

    const base64 = await tab.page.screenshot({ type: 'png', encoding: 'base64' }) as string;
    return { image: `data:image/png;base64,${base64}` };
  });

  // ========== Agent API ==========

  const MAX_CONCURRENT_AGENTS = 5;
  const AGENT_HARD_TIMEOUT = 10 * 60 * 1000; // 10 minutes
  const AGENT_CLEANUP_DELAY = 60 * 1000; // 60s after done

  interface AgentEntry {
    agent: BrowsingAgent;
    buffer: any[];
    finished: boolean;
    cleanupTimer?: ReturnType<typeof setTimeout>;
  }
  const runningAgents = new Map<string, AgentEntry>();
  // 进程级 CookieStore，跨 agent 共享，保持登录状态
  const cookieStore = new CookieStore();

  app.post('/v1/agent/run', async (request) => {
    const { task, apiKey, baseURL, model, messages, maxIterations, headless } = request.body as any;

    if (!task || typeof task !== 'string') {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'task is required', 400);
    }

    // Concurrency limit
    const activeCount = [...runningAgents.values()].filter(e => !e.finished).length;
    if (activeCount >= MAX_CONCURRENT_AGENTS) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, `Max ${MAX_CONCURRENT_AGENTS} concurrent agents`, 429);
    }

    // Create MCP Server + InMemoryTransport + MCP Client
    const mcpHeadless = headless !== undefined ? { headless: headless as boolean } : {};
    const mcpServer = createBrowserMcpServer(sessionManager, cookieStore, mcpHeadless);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const mcpClient = new Client({ name: 'agent', version: '0.1.0' });
    await mcpClient.connect(clientTransport);

    const agent = new BrowsingAgent({
      apiKey: apiKey || undefined,
      baseURL: baseURL || undefined,
      model: model || undefined,
      mcpClient,
      maxIterations: maxIterations || undefined,
      initialMessages: messages || undefined,
    });
    const agentId = randomUUID();
    const entry: AgentEntry = { agent, buffer: [], finished: false };

    // Buffer all events so SSE client can replay them on connect
    // Skip duplicate done events (hard timeout may race with agent completion)
    agent.on('event', (event: any) => {
      if (entry.finished && event.type === 'done') return;
      entry.buffer.push(event);
      if (event.type === 'done') {
        entry.finished = true;
        if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
        entry.cleanupTimer = setTimeout(() => runningAgents.delete(agentId), AGENT_CLEANUP_DELAY);
      }
    });

    runningAgents.set(agentId, entry);

    // Hard timeout: force cleanup if agent runs too long
    entry.cleanupTimer = setTimeout(async () => {
      if (!entry.finished) {
        entry.finished = true;
        entry.buffer.push({ type: 'done', success: false, error: 'Agent timeout', iterations: 0 });
        agent.emit('event', { type: 'done', success: false, error: 'Agent timeout', iterations: 0 });
      }
      try { await mcpClient.close(); } catch {}
      try { await mcpServer.close(); } catch {}
      setTimeout(() => runningAgents.delete(agentId), AGENT_CLEANUP_DELAY);
    }, AGENT_HARD_TIMEOUT);

    // Fire-and-forget with error handling + MCP cleanup
    agent.run(task).catch((err) => {
      if (!entry.finished) {
        entry.finished = true;
        const errEvent = { type: 'done', success: false, error: err.message, iterations: 0 };
        entry.buffer.push(errEvent);
        agent.emit('event', errEvent);
      }
    }).finally(async () => {
      try { await mcpClient.close(); } catch {}
      try { await mcpServer.close(); } catch {}
    });

    return { agentId };
  });

  app.get('/v1/agent/:agentId/events', (request, reply) => {
    const { agentId } = request.params as any;
    const entry = runningAgents.get(agentId);

    if (!entry) {
      reply.status(404).send({ error: { code: 'INVALID_REQUEST', message: 'Agent not found' } });
      return;
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const onEvent = (event: any) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'done') {
        reply.raw.end();
      }
    };

    // Replay buffered events first (synchronous, no events can interleave)
    for (const event of entry.buffer) {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    // If agent already finished, close stream immediately
    if (entry.finished) {
      reply.raw.end();
      return;
    }

    // Only now attach live listener for future events
    entry.agent.on('event', onEvent);

    request.raw.on('close', () => {
      entry.agent.removeListener('event', onEvent);
    });
  });

  // ========== Agent Input (ask_human response) ==========
  app.post('/v1/agent/:agentId/input', async (request) => {
    const { agentId: aid } = request.params as any;
    const { requestId, response } = request.body as any;

    if (!requestId || !response || typeof response !== 'object') {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'requestId and response are required', 400);
    }

    const entry = runningAgents.get(aid);
    if (!entry) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Agent not found', 404);
    }

    const resolved = entry.agent.resolveInput(requestId, response);
    if (!resolved) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'No pending input with this requestId', 400);
    }

    return { success: true };
  });
}