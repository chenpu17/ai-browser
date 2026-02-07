import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserManager } from '../src/browser/BrowserManager.js';
import { SessionManager } from '../src/browser/SessionManager.js';
import { CookieStore } from '../src/browser/CookieStore.js';
import { registerRoutes } from '../src/api/routes.js';

describe('Integration Tests', () => {
  let app: FastifyInstance;
  let browserManager: BrowserManager;
  let sessionManager: SessionManager;
  let fixtureServer: http.Server;
  let fixtureBaseUrl: string;

  beforeAll(async () => {
    // 启动本地 HTTP 服务器提供测试 fixture 文件
    fixtureServer = http.createServer((req, res) => {
      const filePath = path.resolve('tests/fixtures', req.url?.slice(1) || '');
      try {
        const content = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    await new Promise<void>((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
    const addr = fixtureServer.address() as { port: number };
    fixtureBaseUrl = `http://127.0.0.1:${addr.port}`;

    browserManager = new BrowserManager();
    await browserManager.launch({ headless: true });
    sessionManager = new SessionManager(browserManager);
    app = Fastify();
    registerRoutes(app, sessionManager, new CookieStore());
    await app.ready();
  });

  afterAll(async () => {
    await sessionManager.closeAll();
    await browserManager.close();
    await app.close();
    await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
  });

  it('should complete login flow', async () => {
    // 创建会话
    const createRes = await app.inject({ method: 'POST', url: '/v1/sessions' });
    expect(createRes.statusCode).toBe(200);
    const { sessionId } = JSON.parse(createRes.body);

    // 导航到登录页
    const navRes = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/navigate`,
      payload: { url: `${fixtureBaseUrl}/login.html` },
    });
    expect(navRes.statusCode).toBe(200);

    // 获取语义
    const semRes = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/semantic`,
    });
    expect(semRes.statusCode).toBe(200);
    const semantic = JSON.parse(semRes.body);
    expect(semantic.page.type).toBe('login');
  });
});
