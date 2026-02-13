import { FastifyInstance } from 'fastify';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { SessionManager } from '../browser/index.js';
import { CookieStore } from '../browser/CookieStore.js';
import { createBrowserMcpServer } from '../mcp/browser-mcp-server.js';
import type { KnowledgeCardStore } from '../memory/KnowledgeCardStore.js';

export function registerMcpSseRoutes(
  app: FastifyInstance,
  sessionManager: SessionManager,
  cookieStore: CookieStore,
  knowledgeStore?: KnowledgeCardStore
) {

  // sessionId -> SSEServerTransport
  const transports = new Map<string, SSEServerTransport>();

  // GET /mcp/sse — 建立 SSE 连接
  app.get('/mcp/sse', (request, reply) => {
    reply.hijack();

    // Track browser sessions created by this SSE connection
    const createdSessionIds = new Set<string>();

    const transport = new SSEServerTransport('/mcp/message', reply.raw);
    const mcpServer = createBrowserMcpServer(sessionManager, cookieStore, {
      trustLevel: 'remote',
      knowledgeStore,
      onSessionCreated: (browserSessionId) => {
        createdSessionIds.add(browserSessionId);
      },
    });

    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);

    let cleanedUp = false;
    const cleanupConnection = () => {
      if (cleanedUp) return;
      cleanedUp = true;

      transports.delete(sessionId);
      transport.close().catch(() => {});
      mcpServer.close().catch(() => {});

      // Clean up browser sessions created by this SSE connection
      for (const browserSessionId of createdSessionIds) {
        const session = sessionManager.get(browserSessionId);
        if (!session) continue;
        // Skip headful sessions — preserve for manual use
        if (!session.headless) continue;
        sessionManager.close(browserSessionId).catch(() => {});
      }
      createdSessionIds.clear();
    };

    transport.onclose = cleanupConnection;

    mcpServer.connect(transport).catch((err) => {
      app.log.error('MCP SSE connect error:', err);
      cleanupConnection();
    });

    request.raw.on('close', cleanupConnection);
  });

  // POST /mcp/message?sessionId=xxx — 接收 MCP 客户端消息
  app.post('/mcp/message', async (request, reply) => {
    const sessionId = (request.query as any).sessionId as string;
    if (!sessionId) {
      reply.status(400).send({ error: 'sessionId query parameter required' });
      return;
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      reply.status(404).send({ error: 'SSE session not found' });
      return;
    }

    // 使用 raw req/res 调用 handlePostMessage
    await transport.handlePostMessage(request.raw, reply.raw, request.body);
  });
}
