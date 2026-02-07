#!/usr/bin/env node

import { parseArgs } from 'node:util';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { BrowserManager, SessionManager } from '../browser/index.js';
import { registerRoutes, ApiError } from '../api/index.js';
import { registerMcpSseRoutes } from '../api/mcp-sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '0.0.0.0';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', short: 'p' },
    host: { type: 'string', short: 'h' },
  },
  strict: false,
});

async function main() {
  const app = Fastify({ logger: true });

  const browserManager = new BrowserManager();
  await browserManager.launch();

  const sessionManager = new SessionManager(browserManager);

  // 静态文件服务
  await app.register(fastifyStatic, {
    root: path.join(__dirname, '../../public'),
    prefix: '/',
  });

  // 错误处理
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      reply.status(error.statusCode).send(error.toResponse());
    } else {
      app.log.error(error);
      reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
        },
      });
    }
  });

  // 注册 REST API 路由
  registerRoutes(app, sessionManager);

  // 注册 SSE MCP 端点
  registerMcpSseRoutes(app, sessionManager);

  // 优先级: --port > PORT 环境变量 > 默认值
  const portStr = typeof args.port === 'string' ? args.port : process.env.PORT;
  const port = parseInt(portStr || String(DEFAULT_PORT), 10);
  const host = (typeof args.host === 'string' ? args.host : process.env.HOST) || DEFAULT_HOST;

  try {
    await app.listen({ port, host });
    app.log.info(`AI Browser server running at http://${host}:${port}`);
    app.log.info(`MCP SSE endpoint: http://${host}:${port}/mcp/sse`);
  } catch (err) {
    app.log.error(err);
    await browserManager.close();
    process.exit(1);
  }

  // 优雅关闭
  const shutdown = async () => {
    app.log.info('Shutting down...');
    await sessionManager.closeAll();
    await browserManager.close();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(console.error);
