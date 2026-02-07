import { FastifyInstance } from 'fastify';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { SessionManager } from '../browser/index.js';
import { CookieStore } from '../browser/CookieStore.js';
import { createBrowserMcpServer } from '../mcp/browser-mcp-server.js';

export function registerMcpSseRoutes(
  app: FastifyInstance,
  sessionManager: SessionManager
) {
  const cookieStore = new CookieStore();

  // sessionId -> SSEServerTransport
  const transports = new Map<string, SSEServerTransport>();

  // GET /mcp/sse — 建立 SSE 连接
  app.get('/mcp/sse', (request, reply) => {
    reply.hijack();

    const transport = new SSEServerTransport('/mcp/message', reply.raw);
    const mcpServer = createBrowserMcpServer(sessionManager, cookieStore);

    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);

    transport.onclose = () => {
      transports.delete(sessionId);
      mcpServer.close().catch(() => {});
    };

    mcpServer.connect(transport).catch((err) => {
      app.log.error('MCP SSE connect error:', err);
      transports.delete(sessionId);
    });

    request.raw.on('close', () => {
      transports.delete(sessionId);
      transport.close().catch(() => {});
      mcpServer.close().catch(() => {});
    });
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
