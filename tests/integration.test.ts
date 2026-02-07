import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { BrowserManager } from '../src/browser/BrowserManager.js';
import { SessionManager } from '../src/browser/SessionManager.js';
import { registerRoutes } from '../src/api/routes.js';
import path from 'path';

describe('Integration Tests', () => {
  let app: FastifyInstance;
  let browserManager: BrowserManager;
  let sessionManager: SessionManager;

  beforeAll(async () => {
    browserManager = new BrowserManager();
    await browserManager.launch({ headless: true });
    sessionManager = new SessionManager(browserManager);
    app = Fastify();
    registerRoutes(app, sessionManager);
    await app.ready();
  });

  afterAll(async () => {
    await sessionManager.closeAll();
    await browserManager.close();
    await app.close();
  });

  it('should complete login flow', async () => {
    // 创建会话
    const createRes = await app.inject({ method: 'POST', url: '/v1/sessions' });
    expect(createRes.statusCode).toBe(200);
    const { sessionId } = JSON.parse(createRes.body);

    // 导航到登录页
    const filePath = path.resolve('tests/fixtures/login.html');
    const navRes = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/navigate`,
      payload: { url: `file://${filePath}` },
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
