import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTaskTools } from '../src/mcp/task-tools.js';
import { RunManager } from '../src/task/run-manager.js';
import { ArtifactStore } from '../src/task/artifact-store.js';
import type { ToolContext } from '../src/task/tool-context.js';

const mockLoginTemplate = vi.hoisted(() => ({
  executeLoginKeepSession: vi.fn(async (_ctx: unknown, sessionId: string) => ({
    success: true,
    sessionId,
    finalUrl: 'https://example.com/dashboard',
    title: 'Dashboard',
    loginState: 'authenticated',
    cookiesSaved: true,
  })),
}));

vi.mock('../src/task/templates/login-keep-session.js', async () => {
  const actual = await vi.importActual('../src/task/templates/login-keep-session.js');
  return {
    ...actual,
    executeLoginKeepSession: mockLoginTemplate.executeLoginKeepSession,
  };
});

function parseResult(result: any): any {
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

describe('task-tools login template MCP contract', () => {
  let mcpServer: McpServer;
  let mcpClient: Client;
  let runManager: RunManager;
  let artifactStore: ArtifactStore;
  let closeSession: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    runManager = new RunManager();
    artifactStore = new ArtifactStore();
    closeSession = vi.fn(async () => true);

    mcpServer = new McpServer(
      { name: 'task-tools-login-contract-test', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );

    const toolCtx: ToolContext = {
      sessionManager: {
        close: closeSession,
      } as any,
      cookieStore: undefined,
      urlOpts: {},
      trustLevel: 'local',
      resolveSession: async (sessionId?: string) => sessionId ?? 'sess-default',
      getActiveTab: () => {
        throw new Error('not used in this test');
      },
      getTab: () => undefined,
      injectCookies: async () => {},
      saveCookies: async () => {},
    };

    const safe = <T extends (...args: any[]) => Promise<any>>(fn: T) => fn;

    registerTaskTools(
      mcpServer,
      toolCtx,
      runManager,
      artifactStore,
      false,
      safe,
      async (sessionId?: string) => sessionId ?? 'sess-default',
      async () => 'sess-isolated',
    );

    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(st);
    mcpClient = new Client({ name: 'task-tools-login-contract-client', version: '0.1.0' });
    await mcpClient.connect(ct);
  });

  afterEach(async () => {
    try {
      await mcpClient.close();
    } catch {}
    try {
      await mcpServer.close();
    } catch {}
    runManager.dispose();
    artifactStore.dispose();
  });

  it('run_task_template(login_keep_session) returns sessionId/sessionPreserved for owned session', async () => {
    const res = await mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: 'login_keep_session',
        inputs: {
          startUrl: 'https://example.com/login',
          credentials: { username: 'alice', password: 'secret' },
          fields: { mode: 'selector', usernameSelector: '#u', passwordSelector: '#p' },
        },
      },
    });

    const data = parseResult(res);
    expect(res.isError).not.toBe(true);
    expect(data.mode).toBe('sync');
    expect(data.status).toBe('succeeded');
    expect(data.sessionId).toBe('sess-isolated');
    expect(data.sessionPreserved).toBe(true);
    expect(data.result?.sessionId).toBe('sess-isolated');
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('run_task_template(login_keep_session) with provided session keeps sessionPreserved=false', async () => {
    const res = await mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: 'login_keep_session',
        sessionId: 'sess-provided',
        inputs: {
          startUrl: 'https://example.com/login',
          credentials: { username: 'alice', password: 'secret' },
          fields: { mode: 'selector', usernameSelector: '#u', passwordSelector: '#p' },
        },
      },
    });

    const data = parseResult(res);
    expect(res.isError).not.toBe(true);
    expect(data.sessionId).toBe('sess-provided');
    expect(data.sessionPreserved).toBe(false);
    expect(closeSession).not.toHaveBeenCalled();
  });
});
