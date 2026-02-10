import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTaskTools } from '../src/mcp/task-tools.js';
import { RunManager } from '../src/task/run-manager.js';
import { ArtifactStore } from '../src/task/artifact-store.js';
import type { ToolContext } from '../src/task/tool-context.js';

function parseResult(result: any): any {
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

describe('task-tools MCP contract', () => {
  let mcpServer: McpServer;
  let mcpClient: Client;
  let runManager: RunManager;
  let artifactStore: ArtifactStore;

  beforeEach(async () => {
    runManager = new RunManager();
    artifactStore = new ArtifactStore();

    mcpServer = new McpServer(
      { name: 'task-tools-test', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );

    const toolCtx: ToolContext = {
      sessionManager: {
        close: async () => true,
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
    mcpClient = new Client({ name: 'task-tools-test-client', version: '0.1.0' });
    await mcpClient.connect(ct);

    for (let i = 0; i < 5; i++) {
      await runManager.submit(
        'tpl_a',
        'sess-a',
        false,
        1,
        async () => ({ summary: { total: 1, succeeded: 1, failed: 0 } }),
        { mode: 'sync' },
      );
    }

    for (let i = 0; i < 2; i++) {
      await runManager.submit(
        'tpl_b',
        'sess-b',
        false,
        1,
        async () => ({ summary: { total: 1, succeeded: 0, failed: 1 } }),
        { mode: 'sync' },
      );
    }
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

  it('list_task_runs total reflects filtered total, not page size', async () => {
    const res = await mcpClient.callTool({
      name: 'list_task_runs',
      arguments: {
        templateId: 'tpl_a',
        limit: 2,
        offset: 1,
      },
    });

    const data = parseResult(res);
    expect(res.isError).not.toBe(true);
    expect(data.runs).toHaveLength(2);
    expect(data.total).toBe(5);
    expect(data.runs.every((r: any) => r.templateId === 'tpl_a')).toBe(true);
  });

  it('list_task_runs keeps total correct with status filter + pagination', async () => {
    const res = await mcpClient.callTool({
      name: 'list_task_runs',
      arguments: {
        status: 'failed',
        limit: 1,
        offset: 0,
      },
    });

    const data = parseResult(res);
    expect(res.isError).not.toBe(true);
    expect(data.runs).toHaveLength(1);
    expect(data.total).toBe(2);
    expect(data.runs[0].status).toBe('failed');
  });
});
