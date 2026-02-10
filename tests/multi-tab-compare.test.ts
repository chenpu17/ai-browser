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

describe('multi_tab_compare template', () => {
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

  // --- 2-page compare ---

  it('compares two different pages and returns diffs', async () => {
    const res = await mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: 'multi_tab_compare',
        inputs: {
          urls: [fixtureUrl('article.html'), fixtureUrl('login.html')],
        },
        options: { mode: 'sync' },
      },
    });
    const data = parseResult(res);
    expect(res.isError).toBeFalsy();
    expect(data.status).toBe('succeeded');
    expect(data.result.summary.total).toBe(2);
    expect(data.result.summary.succeeded).toBe(2);
    expect(data.result.snapshots).toHaveLength(2);
    expect(data.result.snapshots[0].success).toBe(true);
    expect(data.result.snapshots[1].success).toBe(true);
    // Different pages should have title diff
    expect(data.result.diffs.length).toBeGreaterThan(0);
    const titleDiff = data.result.diffs.find((d: any) => d.field === 'title');
    expect(titleDiff).toBeDefined();
  });

  // --- partial success ---

  it('handles partial success when one URL fails', async () => {
    const res = await mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: 'multi_tab_compare',
        inputs: {
          urls: [fixtureUrl('article.html'), 'ftp://invalid-protocol.example.com'],
        },
        options: { mode: 'sync' },
      },
    });
    const data = parseResult(res);
    expect(res.isError).toBeFalsy();
    expect(data.result.summary.total).toBe(2);
    expect(data.result.summary.succeeded).toBe(1);
    expect(data.result.summary.failed).toBe(1);
    // With only 1 success, no diffs possible
    expect(data.result.diffs).toHaveLength(0);
  });

  // --- same page compare ---

  it('same page produces no diffs', async () => {
    const res = await mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: 'multi_tab_compare',
        inputs: {
          urls: [fixtureUrl('article.html'), fixtureUrl('article.html')],
        },
        options: { mode: 'sync' },
      },
    });
    const data = parseResult(res);
    expect(res.isError).toBeFalsy();
    expect(data.result.summary.succeeded).toBe(2);
    const titleDiff = data.result.diffs.find((d: any) => d.field === 'title');
    expect(titleDiff).toBeUndefined();
  });

  // --- exceeds max URLs ---

  it('rejects more than 10 URLs', async () => {
    const urls = Array.from({ length: 11 }, (_, i) => fixtureUrl('article.html'));
    const res = await mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: 'multi_tab_compare',
        inputs: { urls },
        options: { mode: 'sync' },
      },
    });
    const data = parseResult(res);
    expect(res.isError).toBe(true);
    expect(data.errorCode).toBe('INVALID_PARAMETER');
  });
});
