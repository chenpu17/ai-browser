import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BrowserManager } from '../src/browser/BrowserManager.js';
import { SessionManager } from '../src/browser/SessionManager.js';
import { createBrowserMcpServer } from '../src/mcp/browser-mcp-server.js';

function fixtureUrl(name: string): string {
  return `file://${path.resolve('tests/fixtures', name)}`;
}

function parseResult(result: any): any {
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

describe('login_keep_session template', () => {
  let browserManager: BrowserManager;
  let sessionManager: SessionManager;
  let mcpServer: McpServer;
  let mcpClient: Client;

  beforeAll(async () => {
    browserManager = new BrowserManager();
    await browserManager.launch({ headless: true });
    sessionManager = new SessionManager(browserManager);
  });

  afterAll(async () => {
    await sessionManager.closeAll();
    await browserManager.close();
  });

  beforeEach(async () => {
    mcpServer = createBrowserMcpServer(sessionManager, undefined, {
      trustLevel: 'local',
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(st);
    mcpClient = new Client({ name: 'test', version: '0.1.0' });
    await mcpClient.connect(ct);
  });

  afterEach(async () => {
    try { await mcpClient.close(); } catch {}
    try { await mcpServer.close(); } catch {}
  });

  // --- trust level rejection in remote mode ---

  it('rejects login template in remote mode', async () => {
    // Create a remote-mode server
    const remoteServer = createBrowserMcpServer(sessionManager, undefined, {
      trustLevel: 'remote',
    });
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    await remoteServer.connect(st2);
    const remoteClient = new Client({ name: 'test-remote', version: '0.1.0' });
    await remoteClient.connect(ct2);

    try {
      const res = await remoteClient.callTool({
        name: 'run_task_template',
        arguments: {
          templateId: 'login_keep_session',
          inputs: {
            startUrl: fixtureUrl('login.html'),
            credentials: { username: 'user', password: 'pass' },
            fields: { mode: 'selector', usernameSelector: '#username', passwordSelector: '#password' },
          },
          options: { mode: 'sync' },
        },
      });
      const data = parseResult(res);
      expect(res.isError).toBe(true);
      expect(data.errorCode).toBe('TRUST_LEVEL_NOT_ALLOWED');
    } finally {
      try { await remoteClient.close(); } catch {}
      try { await remoteServer.close(); } catch {}
    }
  });

  // --- selector mode login ---

  it('selector mode navigates and types credentials', async () => {
    // First create a session and navigate so there's an active tab
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    const res = await mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: 'login_keep_session',
        sessionId,
        inputs: {
          startUrl: fixtureUrl('login.html'),
          credentials: { username: 'testuser', password: 'testpass' },
          fields: {
            mode: 'selector',
            usernameSelector: '#username',
            passwordSelector: '#password',
          },
          successIndicator: { type: 'stable' },
        },
        options: { mode: 'sync' },
      },
    });
    const data = parseResult(res);
    expect(res.isError).toBeFalsy();
    expect(data.status).toBe('succeeded');
    expect(data.result.success).toBe(true);
    expect(data.result.finalUrl).toBeTruthy();

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // --- semantic mode login ---

  it('semantic mode finds fields by query', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    const res = await mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: 'login_keep_session',
        sessionId,
        inputs: {
          startUrl: fixtureUrl('login.html'),
          credentials: { username: 'testuser', password: 'testpass' },
          fields: {
            mode: 'semantic',
            usernameQuery: 'username input',
            passwordQuery: 'password input',
            submitQuery: 'login button',
          },
          successIndicator: { type: 'stable' },
        },
        options: { mode: 'sync' },
      },
    });
    const data = parseResult(res);
    expect(res.isError).toBeFalsy();
    expect(data.status).toBe('succeeded');
    expect(data.result.success).toBe(true);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // --- field not found error ---

  it('returns error when selector field not found', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    const res = await mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: 'login_keep_session',
        sessionId,
        inputs: {
          startUrl: fixtureUrl('login.html'),
          credentials: { username: 'user', password: 'pass' },
          fields: {
            mode: 'selector',
            usernameSelector: '#nonexistent-field',
            passwordSelector: '#password',
          },
        },
        options: { mode: 'sync' },
      },
    });
    const data = parseResult(res);
    expect(res.isError).toBe(true);
    expect(data.errorCode).toBe('TPL_LOGIN_FIELD_NOT_FOUND');

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });
});
