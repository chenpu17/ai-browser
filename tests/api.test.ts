import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { BrowserManager } from '../src/browser/BrowserManager.js';
import { SessionManager } from '../src/browser/SessionManager.js';
import { registerRoutes } from '../src/api/routes.js';

describe('API Routes', () => {
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

  describe('GET /health', () => {
    it('should return healthy status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('healthy');
      expect(body.version).toBe('0.1.0');
    });
  });

  describe('GET /v1/info', () => {
    it('should return service info', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/info',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.version).toBe('0.1.0');
      expect(body.capabilities).toContain('semantic');
    });
  });
});
