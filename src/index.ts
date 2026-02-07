import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { BrowserManager, SessionManager } from './browser/index.js';
import { registerRoutes, ApiError } from './api/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '0.0.0.0';

async function main() {
  const app = Fastify({ logger: true });

  const browserManager = new BrowserManager();
  await browserManager.launch();

  const sessionManager = new SessionManager(browserManager);

  // 静态文件服务
  await app.register(fastifyStatic, {
    root: path.join(__dirname, '../public'),
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

  registerRoutes(app, sessionManager);

  const port = parseInt(process.env.PORT || String(DEFAULT_PORT), 10);
  const host = process.env.HOST || DEFAULT_HOST;

  try {
    await app.listen({ port, host });
    app.log.info(`AI Browser server running at http://${host}:${port}`);
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
