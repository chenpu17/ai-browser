import { randomUUID } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { SessionManager } from '../browser/index.js';
import { executeAction } from '../browser/actions.js';
import { validateUrl } from '../utils/url-validator.js';
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
import { TaskAgent, type TaskSpec } from '../agent/task-agent.js';
import { createBrowserMcpServer } from '../mcp/browser-mcp-server.js';
import { CookieStore } from '../browser/CookieStore.js';
import { KnowledgeCardStore, mergePatterns } from '../memory/index.js';
import { SessionRecorder } from '../memory/SessionRecorder.js';
import { RecordingConverter } from '../memory/RecordingConverter.js';
import type { KnowledgeCard, SitePattern } from '../memory/types.js';
import { config } from '../agent/config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const MAX_BATCH_ACTIONS = 50;

export function registerRoutes(
  app: FastifyInstance,
  sessionManager: SessionManager,
  cookieStore: CookieStore,
  knowledgeStore: KnowledgeCardStore
) {
  const elementCollector = new ElementCollector();
  const pageAnalyzer = new PageAnalyzer();
  const regionDetector = new RegionDetector();
  const contentExtractor = new ContentExtractor();
  const iframeHandler = new IframeHandler();
  const elementMatcher = new ElementMatcher();

  // Session recorders — declared early so session close can clean up
  const recorders = new Map<string, SessionRecorder>();

  // 健康检查
  app.get('/health', async () => {
    return { status: 'healthy', version: '0.1.0' };
  });

  // 内存使用情况（用于测试监控）
  app.get('/v1/debug/memory', async () => {
    const mem = process.memoryUsage();
    return {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
    };
  });

  // ========== 站点记忆 API ==========

  // 列出所有域名索引
  app.get('/v1/memory', async () => {
    return { entries: knowledgeStore.listDomains() };
  });

  // 获取完整知识卡片
  app.get('/v1/memory/:domain', async (request) => {
    const { domain } = request.params as any;
    const card = knowledgeStore.loadCard(domain);
    if (!card) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Domain not found', 404);
    }
    return card;
  });

  // 手动添加/更新模式
  app.put('/v1/memory/:domain', async (request) => {
    const { domain } = request.params as any;
    const body = request.body as any;
    const patterns: SitePattern[] = body.patterns || [];

    if (!Array.isArray(patterns) || patterns.length === 0) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'patterns array is required', 400);
    }

    const validTypes = ['selector', 'navigation_path', 'login_required', 'spa_hint', 'page_structure', 'task_intent'];
    for (const p of patterns) {
      if (!p || typeof p !== 'object') {
        throw new ApiError(ErrorCode.INVALID_REQUEST, 'Each pattern must be an object', 400);
      }
      if (!validTypes.includes(p.type)) {
        throw new ApiError(ErrorCode.INVALID_REQUEST, `Invalid pattern type: ${p.type}. Must be one of: ${validTypes.join(', ')}`, 400);
      }
      if (!p.description || typeof p.description !== 'string') {
        throw new ApiError(ErrorCode.INVALID_REQUEST, 'Each pattern must have a description string', 400);
      }
      if (!p.value || typeof p.value !== 'string') {
        throw new ApiError(ErrorCode.INVALID_REQUEST, 'Each pattern must have a value string', 400);
      }
      if (p.value.length > 2000) {
        throw new ApiError(ErrorCode.INVALID_REQUEST, 'Pattern value too long (max 2000 chars)', 400);
      }
    }

    const existing = knowledgeStore.loadCard(domain);
    const now = Date.now();
    // Mark manual patterns
    for (const p of patterns) {
      p.source = p.source || 'manual';
      p.createdAt = p.createdAt || now;
      p.lastUsedAt = p.lastUsedAt || now;
      p.useCount = p.useCount || 0;
      p.confidence = p.confidence ?? 0.8;
    }

    const card: KnowledgeCard = existing
      ? { ...existing, patterns: mergePatterns(existing.patterns, patterns), version: existing.version + 1, updatedAt: now }
      : { domain, version: 1, patterns, siteType: body.siteType, requiresLogin: body.requiresLogin, createdAt: now, updatedAt: now };

    knowledgeStore.saveCard(card);
    return { success: true, domain, patternCount: card.patterns.length };
  });

  // 清除域名记忆
  app.delete('/v1/memory/:domain', async (request) => {
    const { domain } = request.params as any;
    const cleared = knowledgeStore.clearDomain(domain);
    if (!cleared) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Domain not found', 404);
    }
    return { success: true };
  });

  // 列出归档版本
  app.get('/v1/memory/:domain/archive', async (request) => {
    const { domain } = request.params as any;
    const archives = knowledgeStore.listArchives(domain);
    return { domain, archives };
  });

  // 获取归档版本详情
  app.get('/v1/memory/:domain/archive/:filename', async (request) => {
    const { domain, filename } = request.params as any;
    const card = knowledgeStore.loadArchive(domain, filename);
    if (!card) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Archive not found', 404);
    }
    return card;
  });

  // 从归档恢复
  app.post('/v1/memory/:domain/restore/:filename', async (request) => {
    const { domain, filename } = request.params as any;
    const restored = knowledgeStore.restoreArchive(domain, filename);
    if (!restored) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Archive not found', 404);
    }
    return { success: true, domain };
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
    // Clean up any active recorder for this session
    const recorder = recorders.get(sessionId);
    if (recorder?.isRecording()) {
      recorder.stopRecording();
    }
    recorders.delete(sessionId);
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
      const check = validateUrl(url);
      if (!check.valid) {
        throw new ApiError(ErrorCode.INVALID_REQUEST, check.reason, 400);
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
    const check = validateUrl(url);
    if (!check.valid) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, check.reason, 400);
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

    try {
      // Timeout to prevent hanging when page is closed (e.g., headful browser closed by user)
      const screenshotPromise = tab.page.screenshot({ type: 'png', encoding: 'base64' }) as Promise<string>;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Screenshot timeout')), 8000)
      );
      const base64 = await Promise.race([screenshotPromise, timeoutPromise]);
      return { image: `data:image/png;base64,${base64}` };
    } catch (err: any) {
      const msg = err.message || '';
      if (msg.includes('Target closed') || msg.includes('detached') || msg.includes('crashed') || msg.includes('timeout')) {
        throw new ApiError(ErrorCode.INTERNAL_ERROR, 'Page is no longer available', 410);
      }
      throw err;
    }
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

  app.post('/v1/agent/run', async (request) => {
    const body = request.body as any;
    const { task, messages, maxIterations, headless, timeout } = body;
    // Support both flat fields (apiKey, baseURL, model) and nested llm object
    const llm = body.llm || {};
    const apiKey = body.apiKey || llm.apiKey;
    const baseURL = body.baseURL || llm.baseURL;
    const model = body.model || llm.model;

    if (!task || typeof task !== 'string') {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'task is required', 400);
    }

    // Validate messages format
    if (messages !== undefined && messages !== null) {
      if (!Array.isArray(messages)) {
        throw new ApiError(ErrorCode.INVALID_REQUEST, 'messages must be an array', 400);
      }
      const validRoles = ['user', 'assistant', 'system', 'tool'];
      for (const msg of messages) {
        if (!msg || typeof msg !== 'object' || !validRoles.includes(msg.role)) {
          throw new ApiError(ErrorCode.INVALID_REQUEST, `Invalid message: each message must have a valid role (${validRoles.join('/')})`, 400);
        }
      }
    }

    // Concurrency limit
    const activeCount = [...runningAgents.values()].filter(e => !e.finished).length;
    if (activeCount >= MAX_CONCURRENT_AGENTS) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, `Max ${MAX_CONCURRENT_AGENTS} concurrent agents`, 429);
    }

    // Create MCP Server + InMemoryTransport + MCP Client
    const mcpHeadless = headless !== undefined ? { headless: headless as boolean } : {};
    const mcpServer = createBrowserMcpServer(sessionManager, cookieStore, {
      ...mcpHeadless,
      trustLevel: 'local',
      knowledgeStore,
    });
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
      timeout: timeout || undefined,
      initialMessages: messages || undefined,
      knowledgeStore,
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
        entry.cleanupTimer.unref?.();
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
      const deleteTimer = setTimeout(() => runningAgents.delete(agentId), AGENT_CLEANUP_DELAY);
      deleteTimer.unref?.();
    }, AGENT_HARD_TIMEOUT);
    entry.cleanupTimer.unref?.();

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

  // ========== TaskAgent API (v1) ==========

  interface TaskEntry {
    taskAgent: TaskAgent;
    buffer: any[];
    finished: boolean;
    status: 'running' | 'done';
    traceId: string;
    createdAt: number;
    updatedAt: number;
    result?: any;
    error?: string;
    goal?: string;
    hardTimeoutTimer?: ReturnType<typeof setTimeout>;
    cleanupTimer?: ReturnType<typeof setTimeout>;
    closeResources: () => Promise<void>;
  }

  const runningTasks = new Map<string, TaskEntry>();

  function normalizeTaskEvent(taskId: string, fallbackTraceId: string, event: any) {
    const raw = event && typeof event === 'object'
      ? event
      : { type: 'unknown_event', value: event };

    return {
      ...raw,
      taskId,
      traceId: raw.traceId || fallbackTraceId,
      ts: raw.ts || new Date().toISOString(),
    };
  }

  app.post('/v1/tasks', async (request) => {
    const body = request.body as any;
    const {
      taskSpec: rawTaskSpec,
      goal,
      inputs,
      constraints,
      budget,
      outputSchema,
      messages,
      maxIterations,
      headless,
    } = body;
    // Support both flat fields (apiKey, baseURL, model) and nested llm object
    const llm = body.llm || {};
    const apiKey = body.apiKey || llm.apiKey;
    const baseURL = body.baseURL || llm.baseURL;
    const model = body.model || llm.model;

    const taskSpec: TaskSpec = rawTaskSpec && typeof rawTaskSpec === 'object'
      ? rawTaskSpec
      : { goal, inputs, constraints, budget, outputSchema };

    if (!taskSpec?.goal || typeof taskSpec.goal !== 'string') {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'taskSpec.goal is required', 400);
    }

    const activeAgents = [...runningAgents.values()].filter((e) => !e.finished).length;
    const activeTasks = [...runningTasks.values()].filter((e) => !e.finished).length;
    if (activeAgents + activeTasks >= MAX_CONCURRENT_AGENTS) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, `Max ${MAX_CONCURRENT_AGENTS} concurrent task/agent runs`, 429);
    }

    let mcpServer: any | undefined;
    let mcpClient: Client | undefined;
    let resourcesClosed = false;
    const closeResources = async () => {
      if (resourcesClosed) return;
      resourcesClosed = true;
      if (mcpClient) {
        try { await mcpClient.close(); } catch {}
      }
      if (mcpServer) {
        try { await mcpServer.close(); } catch {}
      }
    };

    try {
      const mcpHeadless = headless !== undefined ? { headless: headless as boolean } : {};
      mcpServer = createBrowserMcpServer(sessionManager, cookieStore, {
        ...mcpHeadless,
        trustLevel: 'local',
        knowledgeStore,
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await mcpServer.connect(serverTransport);
      mcpClient = new Client({ name: 'task-agent', version: '0.1.0' });
      await mcpClient.connect(clientTransport);

      let taskAgent!: TaskAgent;
      const runAgentGoal = async (goalText: string) => {
        const nestedAgent = new BrowsingAgent({
          apiKey: apiKey || undefined,
          baseURL: baseURL || undefined,
          model: model || undefined,
          mcpClient: mcpClient!,
          maxIterations: maxIterations || undefined,
          initialMessages: messages || undefined,
          knowledgeStore,
        });

        const forwardEvent = (event: any) => {
          taskAgent.emit('event', {
            type: 'agent_event',
            event,
          });
        };
        nestedAgent.on('event', forwardEvent);

        try {
          const result = await nestedAgent.run(goalText);
          return {
            success: result.success,
            result: result.result,
            error: result.error,
            iterations: result.iterations,
          };
        } finally {
          nestedAgent.removeListener('event', forwardEvent);
        }
      };

      taskAgent = new TaskAgent({
        mcpClient: mcpClient,
        runAgentGoal,
      });

      const taskId = (taskSpec.taskId && /^[a-zA-Z0-9_-]{1,64}$/.test(taskSpec.taskId))
        ? taskSpec.taskId
        : randomUUID();
      if (runningTasks.has(taskId)) {
        throw new ApiError(ErrorCode.INVALID_REQUEST, `Task ID '${taskId}' already exists`, 409);
      }
      const traceId = taskAgent.resetTraceId();
      const entry: TaskEntry = {
        taskAgent,
        buffer: [],
        finished: false,
        status: 'running',
        traceId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        goal: taskSpec.goal,
        closeResources,
      };

      taskAgent.on('event', (event: any) => {
        const normalized = normalizeTaskEvent(taskId, entry.traceId, event);
        entry.buffer.push(normalized);
        entry.updatedAt = Date.now();
        entry.traceId = normalized.traceId;

        if (normalized.type !== 'done') return;

        entry.finished = true;
        entry.status = 'done';
        if (entry.hardTimeoutTimer) {
          clearTimeout(entry.hardTimeoutTimer);
          entry.hardTimeoutTimer = undefined;
        }
        if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
        entry.cleanupTimer = setTimeout(() => runningTasks.delete(taskId), AGENT_CLEANUP_DELAY);
        entry.cleanupTimer.unref?.();
        void entry.closeResources();
      });

      runningTasks.set(taskId, entry);

      entry.hardTimeoutTimer = setTimeout(() => {
        if (entry.finished) return;
        entry.error = 'Task timeout';
        entry.updatedAt = Date.now();
        taskAgent.emit('event', {
          type: 'done',
          success: false,
          error: 'Task timeout',
          iterations: 0,
        });
      }, AGENT_HARD_TIMEOUT);
      entry.hardTimeoutTimer.unref?.();

      void taskAgent.run(taskSpec)
        .then((result) => {
          entry.result = result;
          entry.error = result.error;
          entry.updatedAt = Date.now();
          // TaskAgent.run emits done in finalize(); this guard only handles rare edge paths.
          if (!entry.finished) {
            taskAgent.emit('event', {
              type: 'done',
              success: result.success,
              runId: result.runId,
              summary: result.summary,
              error: result.error,
              iterations: result.iterations,
            });
          }
        })
        .catch((err: any) => {
          entry.error = err?.message || 'Task execution failed';
          entry.updatedAt = Date.now();
          if (!entry.finished) {
            taskAgent.emit('event', {
              type: 'done',
              success: false,
              error: entry.error,
              iterations: 0,
            });
          }
        });

      return {
        taskId,
        traceId: entry.traceId,
        status: entry.status,
      };
    } catch (err) {
      await closeResources();
      throw err;
    }
  });


  // List all tasks (summary)
  app.get('/v1/tasks', async () => {
    const tasks: any[] = [];
    for (const [taskId, entry] of runningTasks) {
      tasks.push({
        taskId,
        status: entry.status,
        traceId: entry.traceId,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        goal: entry.goal || '',
      });
    }
    tasks.sort((a, b) => b.createdAt - a.createdAt);
    return { tasks };
  });

  app.get('/v1/tasks/:taskId', async (request) => {
    const { taskId } = request.params as any;
    const entry = runningTasks.get(taskId);
    if (!entry) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Task not found', 404);
    }

    const lastEvent = entry.buffer.length > 0 ? entry.buffer[entry.buffer.length - 1] : null;
    return {
      taskId,
      status: entry.status,
      traceId: entry.traceId,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      goal: entry.goal,
      lastEvent,
      result: entry.result,
      error: entry.error,
    };
  });

  app.get('/v1/tasks/:taskId/events', (request, reply) => {
    const { taskId } = request.params as any;
    const entry = runningTasks.get(taskId);

    if (!entry) {
      reply.status(404).send({ error: { code: 'INVALID_REQUEST', message: 'Task not found' } });
      return;
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const onEvent = (event: any) => {
      const liveEvent = event && typeof event === 'object'
        ? ({ ...event, taskId })
        : { taskId, type: 'unknown_event', value: event, ts: new Date().toISOString(), traceId: entry.traceId };
      reply.raw.write(`data: ${JSON.stringify(liveEvent)}\n\n`);
      if (liveEvent.type === 'done') {
        reply.raw.end();
      }
    };

    for (const event of entry.buffer) {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    if (entry.finished) {
      reply.raw.end();
      return;
    }

    entry.taskAgent.on('event', onEvent);

    request.raw.on('close', () => {
      entry.taskAgent.removeListener('event', onEvent);
    });
  });

  // ========== Session Recording API (Phase B) ==========

  // Start recording
  app.post('/v1/sessions/:sessionId/recording/start', async (request) => {
    const { sessionId } = request.params as any;
    const session = sessionManager.get(sessionId);
    if (!session) {
      throw new ApiError(ErrorCode.SESSION_NOT_FOUND, 'Session not found', 404);
    }
    if (recorders.has(sessionId)) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Already recording', 400);
    }
    const tab = sessionManager.getActiveTab(sessionId);
    if (!tab) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'No active tab', 400);
    }
    const recorder = new SessionRecorder(sessionId);
    const recordingId = randomUUID();
    await recorder.startRecording(tab.page, recordingId);
    recorders.set(sessionId, recorder);
    return { success: true, recordingId };
  });

  // Stop recording
  app.post('/v1/sessions/:sessionId/recording/stop', async (request) => {
    const { sessionId } = request.params as any;
    const { convertToMemory } = (request.body as any) || {};
    const recorder = recorders.get(sessionId);
    if (!recorder || !recorder.isRecording()) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Not recording', 400);
    }
    const recording = recorder.stopRecording();
    recorders.delete(sessionId);
    if (!recording) {
      return { success: true, events: 0 };
    }

    let savedDomain: string | undefined;
    if (convertToMemory && recording.events.length > 0) {
      const domain = RecordingConverter.extractDomain(recording);
      if (domain) {
        const patterns = RecordingConverter.convert(recording);
        if (patterns.length > 0) {
          const existing = knowledgeStore.loadCard(domain);
          const now = Date.now();
          const card: KnowledgeCard = existing
            ? { ...existing, patterns: mergePatterns(existing.patterns, patterns), version: existing.version + 1, updatedAt: now }
            : { domain, version: 1, patterns, createdAt: now, updatedAt: now };
          knowledgeStore.saveCard(card);
          savedDomain = domain;
        }
      }
    }

    return {
      success: true,
      events: recording.events.length,
      domain: recording.domain,
      savedToMemory: savedDomain || null,
      recording,
    };
  });

  // Get recording status
  app.get('/v1/sessions/:sessionId/recording', async (request) => {
    const { sessionId } = request.params as any;
    const recorder = recorders.get(sessionId);
    if (!recorder) {
      return { recording: false, eventCount: 0, domain: '' };
    }
    return recorder.getStatus();
  });

  // Summarize recording events into task intent via LLM
  app.post('/v1/recordings/summarize', async (request) => {
    const body = request.body as any;
    const events = body.events;
    const domain = body.domain || '';

    // Support per-request LLM config (same pattern as /v1/agent/run)
    const llm = body.llm || {};
    const apiKey = body.apiKey || llm.apiKey || config.llm.apiKey;
    const baseURL = body.baseURL || llm.baseURL || config.llm.baseURL || 'https://api.openai.com/v1';
    const model = body.model || llm.model || config.llm.model || 'gpt-4o-mini';
    const timeoutMs = Math.min(Math.max((body.timeout || 300) * 1000, 10000), 600000); // 10s–600s, default 300s

    if (!Array.isArray(events) || events.length === 0) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'events array is required', 400);
    }
    if (events.length > 500) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, 'Too many events (max 500)', 400);
    }

    if (!apiKey) {
      return { intent: '', error: 'LLM not configured — set API Key in Settings' };
    }

    // Build a compact event summary for the prompt (limit to avoid token explosion)
    const maxPromptEvents = 100;
    const eventLines = events.slice(0, maxPromptEvents).map((e: any) => {
      const parts = [e.type];
      if (e.type === 'navigate') parts.push(e.url || '');
      else if (e.type === 'click') parts.push(e.targetLabel || e.target || '');
      else if (e.type === 'type') parts.push(`${e.targetLabel || e.target || ''} = "${(e.value || '').slice(0, 50)}"`);
      else if (e.type === 'select') parts.push(`${e.targetLabel || e.target || ''} = "${e.value || ''}"`);
      else if (e.type === 'scroll') parts.push(`y=${e.value || ''}`);
      return parts.join(': ');
    }).join('\n');
    const truncNote = events.length > maxPromptEvents ? `\n(... 还有 ${events.length - maxPromptEvents} 个事件未显示)` : '';

    const prompt = `你是一个浏览器自动化专家。以下是用户在 ${domain || '某网站'} 上的操作录制事件序列。

你的任务是提取**可复用的操作流程**，而不是关注具体的内容。
- 重点描述"怎么操作这个网站"，而不是"操作了什么具体内容"
- 将具体的搜索词、文本、URL 等替换为通用占位符（如 <关键词>、<目标内容>）
- 输出应该像一份操作手册，让 AI agent 下次能复用同样的流程

格式要求：
意图：<一句话描述这是什么类型的操作流程，例如"在Bing上搜索关键词并查看结果">
步骤：
1. <步骤1，用占位符替代具体值>
2. <步骤2>
...

事件序列：
${eventLines}${truncNote}`;

    const llmUrl = baseURL.replace(/\/+$/, '') + '/chat/completions';

    try {
      const res = await fetch(llmUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 500,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { intent: '', error: `LLM HTTP ${res.status}: ${text.slice(0, 200)}` };
      }

      const data = await res.json() as any;
      const content = data.choices?.[0]?.message?.content || '';
      return { intent: content.trim() };
    } catch (err: any) {
      const timeoutHint = err.message?.includes('timeout') ? ` (timeout=${timeoutMs / 1000}s, adjust in Settings)` : '';
      return { intent: '', error: `LLM call failed (${llmUrl}): ${err.message}${timeoutHint}` };
    }
  });

  // ========== LLM Connection Test ==========

  app.post('/v1/llm/test', async (request) => {
    const body = request.body as any;
    const llmCfg = body.llm || {};
    const apiKey = body.apiKey || llmCfg.apiKey;
    const model = body.model || llmCfg.model;
    const baseURL = body.baseURL || llmCfg.baseURL;
    const testModel = model || 'gpt-4';
    const testBaseURL = baseURL || 'https://api.openai.com/v1';
    if (!apiKey) {
      return { ok: false, error: 'API Key is required' };
    }
    // SSRF protection: only allow https URLs, block private/internal addresses
    const urlCheck = validateUrl(testBaseURL, { blockPrivate: true });
    if (!urlCheck.valid) {
      return { ok: false, error: 'Invalid base URL: ' + urlCheck.reason };
    }
    const start = Date.now();
    try {
      const res = await fetch(testBaseURL.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: testModel,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(15000),
      });
      const latencyMs = Date.now() - start;
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}`, latencyMs };
      }
      return { ok: true, model: testModel, latencyMs };
    } catch (err: any) {
      return { ok: false, error: err.message, latencyMs: Date.now() - start };
    }
  });

}
