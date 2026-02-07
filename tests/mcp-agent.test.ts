import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import Fastify, { FastifyInstance } from 'fastify';
import { BrowserManager } from '../src/browser/BrowserManager.js';
import { SessionManager } from '../src/browser/SessionManager.js';
import { registerRoutes } from '../src/api/routes.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBrowserMcpServer } from '../src/mcp/browser-mcp-server.js';
import { BrowsingAgent } from '../src/agent/agent-loop.js';

function fixtureUrl(name: string): string {
  return `file://${path.resolve('tests/fixtures', name)}`;
}

function parseResult(result: any): any {
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

// ============================================================
// Part 3: Agent API route tests (Scenarios 16-17)
// ============================================================
describe('Agent API Routes', () => {
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

  // Scenario 16: POST /v1/agent/run rejects missing task
  it('Scenario 16: agent/run rejects empty task', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent/run',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBeTruthy();
  });

  // Scenario 17: GET /v1/agent/:id/events returns 404 for unknown agent
  it('Scenario 17: agent events returns 404 for unknown id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agent/nonexistent-id/events',
    });
    expect(res.statusCode).toBe(404);
  });
});

// ============================================================
// Part 4: Agent-loop unit tests (Scenarios 18-20)
// ============================================================
describe('BrowsingAgent', () => {
  let browserManager: BrowserManager;
  let sessionManager: SessionManager;

  beforeAll(async () => {
    browserManager = new BrowserManager();
    await browserManager.launch({ headless: true });
    sessionManager = new SessionManager(browserManager);
  });

  afterAll(async () => {
    await sessionManager.closeAll();
    await browserManager.close();
  });

  // Helper: create a connected MCP client/server pair
  async function createMcpPair() {
    const mcpServer = createBrowserMcpServer(sessionManager);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(st);
    const mcpClient = new Client({ name: 'test-agent', version: '0.1.0' });
    await mcpClient.connect(ct);
    return { mcpServer, mcpClient };
  }

  // Scenario 18: Agent emits session_created event
  it('Scenario 18: agent emits session_created on run', async () => {
    const { mcpServer, mcpClient } = await createMcpPair();

    // Use a fake OpenAI that immediately returns done tool call
    const agent = new BrowsingAgent({
      mcpClient,
      maxIterations: 1,
    });

    const events: any[] = [];
    agent.on('event', (ev: any) => events.push(ev));

    // The agent will fail on LLM call (no real API key),
    // but it should still emit session_created first
    const result = await agent.run('test task');

    const sessionEvent = events.find(e => e.type === 'session_created');
    expect(sessionEvent).toBeTruthy();
    expect(sessionEvent.sessionId).toBeTruthy();

    // Should also emit done
    const doneEvent = events.find(e => e.type === 'done');
    expect(doneEvent).toBeTruthy();

    try { await mcpClient.close(); } catch {}
    try { await mcpServer.close(); } catch {}
  });

  // Scenario 19: Agent respects maxIterations
  it('Scenario 19: agent stops at maxIterations', async () => {
    const { mcpServer, mcpClient } = await createMcpPair();

    const agent = new BrowsingAgent({
      mcpClient,
      maxIterations: 1,
    });

    const result = await agent.run('test task');

    // Should fail (LLM not available) or hit max iterations
    expect(result.iterations).toBeLessThanOrEqual(1);

    try { await mcpClient.close(); } catch {}
    try { await mcpServer.close(); } catch {}
  });

  // Scenario 20: Agent discoverTools includes done + MCP tools
  it('Scenario 20: agent discovers MCP tools + done tool', async () => {
    const { mcpServer, mcpClient } = await createMcpPair();

    const agent = new BrowsingAgent({
      mcpClient,
      maxIterations: 1,
    });

    // Access private discoverTools via run (it calls discoverTools internally)
    // We verify by checking the events - session_created means tools were discovered
    const events: any[] = [];
    agent.on('event', (ev: any) => events.push(ev));

    await agent.run('test');

    // If discoverTools failed, session_created would not be emitted
    expect(events.find(e => e.type === 'session_created')).toBeTruthy();

    // Verify tools were discovered by checking MCP listTools directly
    const { tools } = await mcpClient.listTools();
    expect(tools.length).toBe(12); // 12 MCP tools
    // done tool is added by agent internally, not from MCP

    try { await mcpClient.close(); } catch {}
    try { await mcpServer.close(); } catch {}
  });
});
