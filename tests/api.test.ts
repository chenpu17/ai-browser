import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import Fastify, { FastifyInstance } from 'fastify';
import { BrowserManager } from '../src/browser/BrowserManager.js';
import { SessionManager } from '../src/browser/SessionManager.js';
import { CookieStore } from '../src/browser/CookieStore.js';
import { registerRoutes } from '../src/api/routes.js';

function fixtureUrl(name: string): string {
  return `file://${path.resolve('tests/fixtures', name)}`;
}

async function pollTask(app: FastifyInstance, taskId: string, rounds = 20): Promise<any> {
  let latest: any = null;
  for (let i = 0; i < rounds; i++) {
    const statusResp = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}`,
    });
    expect(statusResp.statusCode).toBe(200);
    latest = JSON.parse(statusResp.body);
    if (latest.status === 'done') return latest;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return latest;
}

describe('API Routes', () => {
  let app: FastifyInstance;
  let browserManager: BrowserManager;
  let sessionManager: SessionManager;

  beforeAll(async () => {
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
      expect(body.version).toBeTruthy();
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
      expect(body.version).toBeTruthy();
      expect(body.capabilities).toContain('semantic');
    });
  });

  describe('Task API /v1/tasks', () => {
    it('rejects missing task goal', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/tasks',
        payload: {},
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error?.code || body.code).toBe('INVALID_REQUEST');
    });

    it('creates task run and exposes final result state', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/tasks',
        payload: {
          goal: '批量提取页面信息',
          inputs: {
            urls: [fixtureUrl('article.html')],
          },
          constraints: { maxDurationMs: 10000 },
          budget: { maxRetries: 0 },
          outputSchema: {
            type: 'object',
            properties: {
              items: { type: 'array' },
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const created = JSON.parse(response.body);
      expect(created.taskId).toBeTruthy();
      expect(created.traceId).toBeTruthy();
      expect(created.status).toBe('running');

      const latest = await pollTask(app, created.taskId);
      expect(latest.taskId).toBe(created.taskId);
      expect(latest.traceId).toBe(created.traceId);
      expect(typeof latest.createdAt).toBe('number');
      expect(typeof latest.updatedAt).toBe('number');
      expect(latest.status).toBe('done');
      expect(latest.lastEvent?.type).toBe('done');
      expect(latest.result?.traceId).toBe(created.traceId);
      expect(typeof latest.result?.success).toBe('boolean');
    });

    it('accepts taskSpec envelope payload', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/tasks',
        payload: {
          taskSpec: {
            goal: '批量提取页面信息',
            inputs: {
              urls: [fixtureUrl('article.html')],
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const created = JSON.parse(response.body);
      expect(created.taskId).toBeTruthy();
      const latest = await pollTask(app, created.taskId);
      expect(latest.status).toBe('done');
    });


    it('streams task events over SSE endpoint', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/tasks',
        payload: {
          goal: '批量提取页面信息',
          inputs: {
            urls: [fixtureUrl('article.html')],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const created = JSON.parse(response.body);

      const eventsResp = await app.inject({
        method: 'GET',
        url: `/v1/tasks/${created.taskId}/events`,
      });

      expect(eventsResp.statusCode).toBe(200);
      expect(String(eventsResp.headers['content-type'])).toContain('text/event-stream');
      expect(eventsResp.body).toContain('"type":"plan_created"');
      expect(eventsResp.body).toContain('"type":"done"');
    });

    it('returns 404 for unknown task id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/tasks/not-found',
      });
      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error?.code || body.code).toBe('INVALID_REQUEST');
    });
  });
});
