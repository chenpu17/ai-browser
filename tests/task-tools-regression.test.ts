import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTaskTools } from '../src/mcp/task-tools.js';
import { RunManager } from '../src/task/run-manager.js';
import { ArtifactStore } from '../src/task/artifact-store.js';
import type { ToolContext } from '../src/task/tool-context.js';

const templateMocks = vi.hoisted(() => ({
  executeBatchExtract: vi.fn(async () => ({
    summary: { total: 1, succeeded: 1, failed: 0 },
    items: [{ url: 'https://example.com', success: true }],
  })),
  executeLoginKeepSession: vi.fn(async (_ctx: unknown, sessionId: string) => ({
    success: true,
    sessionId,
    finalUrl: 'https://example.com/dashboard',
    title: 'Dashboard',
    loginState: 'authenticated',
    cookiesSaved: true,
  })),
  executeMultiTabCompare: vi.fn(async () => ({
    summary: { total: 2, succeeded: 2, failed: 0 },
    snapshots: [],
    diffs: [],
  })),
}));

vi.mock('../src/task/templates/batch-extract.js', async () => {
  const actual = await vi.importActual('../src/task/templates/batch-extract.js');
  return {
    ...actual,
    executeBatchExtract: templateMocks.executeBatchExtract,
  };
});

vi.mock('../src/task/templates/login-keep-session.js', async () => {
  const actual = await vi.importActual('../src/task/templates/login-keep-session.js');
  return {
    ...actual,
    executeLoginKeepSession: templateMocks.executeLoginKeepSession,
  };
});

vi.mock('../src/task/templates/multi-tab-compare.js', async () => {
  const actual = await vi.importActual('../src/task/templates/multi-tab-compare.js');
  return {
    ...actual,
    executeMultiTabCompare: templateMocks.executeMultiTabCompare,
  };
});

function parseResult(result: any): any {
  const text = result.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

describe('task-tools regression coverage', () => {
  let mcpServer: McpServer;
  let mcpClient: Client;
  let runManager: RunManager;
  let artifactStore: ArtifactStore;
  let closeSession: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    runManager = new RunManager();
    artifactStore = new ArtifactStore();
    closeSession = vi.fn(async () => true);

    mcpServer = new McpServer(
      { name: 'task-tools-regression-test', version: '0.1.0' },
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

    const safe = <T extends (...args: any[]) => Promise<any>>(fn: T) => {
      return (async (...args: Parameters<T>) => {
        try {
          return await fn(...args);
        } catch (err: any) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: err?.message || 'Unknown error', errorCode: err?.errorCode }),
              },
            ],
            isError: true as const,
          };
        }
      }) as T;
    };

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
    mcpClient = new Client({ name: 'task-tools-regression-client', version: '0.1.0' });
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

  it('maps login template result.success=false to failed and keeps owned session', async () => {
    templateMocks.executeLoginKeepSession.mockResolvedValueOnce({
      success: false,
      sessionId: 'sess-isolated',
      finalUrl: 'https://example.com/login',
      title: 'Login',
      loginState: 'unknown',
      cookiesSaved: true,
      error: 'Success indicator not reached within timeout',
    });

    const runRes = await mcpClient.callTool({
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

    const runData = parseResult(runRes);
    expect(runRes.isError).not.toBe(true);
    expect(runData.status).toBe('failed');
    expect(runData.sessionPreserved).toBe(true);
    expect(closeSession).not.toHaveBeenCalled();

    const pollRes = await mcpClient.callTool({
      name: 'get_task_run',
      arguments: { runId: runData.runId },
    });
    const pollData = parseResult(pollRes);
    expect(pollData.status).toBe('failed');
    expect(pollData.result?.success).toBe(false);
    expect(pollData.sessionId).toBe('sess-isolated');
    expect(pollData.ownsSession).toBe(true);
  });

  it('auto-created non-login sessions are closed on terminal', async () => {
    const runRes = await mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: 'batch_extract_pages',
        inputs: { urls: ['https://example.com'] },
        options: { mode: 'sync' },
      },
    });

    const runData = parseResult(runRes);
    expect(runRes.isError).not.toBe(true);
    expect(runData.status).toBe('succeeded');
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledWith('sess-isolated');
  });

  it('rejects incompatible multi_tab_compare extract/compare settings', async () => {
    const res = await mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: 'multi_tab_compare',
        inputs: {
          urls: ['https://example.com/a', 'https://example.com/b'],
          extract: { pageInfo: false },
          compare: { fields: ['title'] },
        },
        options: { mode: 'sync' },
      },
    });

    const data = parseResult(res);
    expect(res.isError).toBe(true);
    expect(String(data.error)).toContain('pageInfo=false');
  });

  it('run_task_template rejects invalid mode with structured error', async () => {
    const res = await mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: 'batch_extract_pages',
        inputs: { urls: ['https://example.com'] },
        options: { mode: 'fast' },
      },
    });

    const data = parseResult(res);
    expect(res.isError).toBe(true);
    expect(data.errorCode).toBe('INVALID_PARAMETER');
    expect(String(data.error)).toContain('options.mode');
  });

  it('list_task_runs rejects invalid status enum with structured error', async () => {
    const res = await mcpClient.callTool({
      name: 'list_task_runs',
      arguments: { status: 'bad_status' },
    });

    const data = parseResult(res);
    expect(res.isError).toBe(true);
    expect(data.errorCode).toBe('INVALID_PARAMETER');
  });
});
