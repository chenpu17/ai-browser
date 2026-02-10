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

describe('batch_extract_pages', () => {
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

  // --- list_task_templates ---

  it('list_task_templates returns batch_extract_pages', async () => {
    const res = await mcpClient.callTool({ name: 'list_task_templates', arguments: {} });
    const data = parseResult(res);
    expect(data.templates).toHaveLength(3);
    expect(data.templates[0].templateId).toBe('batch_extract_pages');
    expect(data.templates[0].executionMode).toBe('auto');
  });

  // --- template not found ---

  it('run_task_template rejects unknown templateId', async () => {
    const res = await mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: 'nonexistent',
        inputs: { urls: ['https://example.com'] },
      },
    });
    const data = parseResult(res);
    expect(res.isError).toBe(true);
    expect(data.errorCode).toBe('TEMPLATE_NOT_FOUND');
  });

  // --- invalid inputs ---

  it('run_task_template rejects empty urls array', async () => {
    const res = await mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: 'batch_extract_pages',
        inputs: { urls: [] },
      },
    });
    const data = parseResult(res);
    expect(res.isError).toBe(true);
    expect(data.errorCode).toBe('INVALID_PARAMETER');
  });

  // --- sync mode: single URL ---

  it('sync mode extracts a single local page', async () => {
    const res = await mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: 'batch_extract_pages',
        inputs: {
          urls: [fixtureUrl('article.html')],
          extract: { pageInfo: true, content: true },
        },
        options: { mode: 'sync' },
      },
    });
    const data = parseResult(res);
    expect(res.isError).toBeFalsy();
    expect(data.status).toBe('succeeded');
    expect(data.mode).toBe('sync');
    expect(data.result.summary.total).toBe(1);
    expect(data.result.summary.succeeded).toBe(1);
    expect(data.result.summary.failed).toBe(0);
    expect(data.result.items[0].success).toBe(true);
    expect(data.result.items[0].title).toBeTruthy();
    expect(data.result.items[0].content).toBeTruthy();
  });

  // --- sync mode: multiple URLs ---

  it('sync mode extracts multiple local pages', async () => {
    const res = await mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: 'batch_extract_pages',
        inputs: {
          urls: [fixtureUrl('article.html'), fixtureUrl('form.html')],
          concurrency: 2,
        },
        options: { mode: 'sync' },
      },
    });
    const data = parseResult(res);
    expect(res.isError).toBeFalsy();
    expect(data.status).toBe('succeeded');
    expect(data.result.summary.total).toBe(2);
    expect(data.result.summary.succeeded).toBe(2);
    expect(data.result.items).toHaveLength(2);
    expect(data.result.items[0].success).toBe(true);
    expect(data.result.items[1].success).toBe(true);
  });

  // --- async mode + get_task_run polling ---

  it('async mode returns runId, get_task_run retrieves result', async () => {
    const res = await mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: 'batch_extract_pages',
        inputs: {
          urls: [fixtureUrl('article.html')],
        },
        options: { mode: 'async' },
      },
    });
    const data = parseResult(res);
    expect(res.isError).toBeFalsy();
    expect(data.runId).toBeTruthy();
    expect(data.mode).toBe('async');

    // Poll until terminal state
    let run: any;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      const pollRes = await mcpClient.callTool({
        name: 'get_task_run',
        arguments: { runId: data.runId },
      });
      run = parseResult(pollRes);
      if (run.status !== 'queued' && run.status !== 'running') break;
    }

    expect(run.status).toBe('succeeded');
    expect(run.result.summary.total).toBe(1);
    expect(run.result.summary.succeeded).toBe(1);
  });

  // --- partial success: mix of valid and invalid URLs ---

  it('partial success when some URLs are invalid', async () => {
    const res = await mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: 'batch_extract_pages',
        inputs: {
          urls: [
            fixtureUrl('article.html'),
            'ftp://invalid-protocol.example.com',
          ],
        },
        options: { mode: 'sync' },
      },
    });
    const data = parseResult(res);
    expect(res.isError).toBeFalsy();
    expect(data.result.summary.total).toBe(2);
    expect(data.result.summary.succeeded).toBe(1);
    expect(data.result.summary.failed).toBe(1);
    // 1 out of 2 succeeded = 50% → partial_success
    expect(data.status).toBe('partial_success');
  });

  // --- all URLs invalid → failed ---

  it('failed status when all URLs are invalid', async () => {
    const res = await mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: 'batch_extract_pages',
        inputs: {
          urls: [
            'ftp://bad1.example.com',
            'ftp://bad2.example.com',
          ],
        },
        options: { mode: 'sync' },
      },
    });
    const data = parseResult(res);
    expect(res.isError).toBeFalsy();
    expect(data.result.summary.total).toBe(2);
    expect(data.result.summary.succeeded).toBe(0);
    expect(data.result.summary.failed).toBe(2);
    expect(data.status).toBe('failed');
  });

  // --- get_task_run with invalid runId ---

  it('get_task_run returns error for unknown runId', async () => {
    const res = await mcpClient.callTool({
      name: 'get_task_run',
      arguments: { runId: 'nonexistent-run-id' },
    });
    const data = parseResult(res);
    expect(res.isError).toBe(true);
    expect(data.errorCode).toBe('RUN_NOT_FOUND');
  });

  // --- auto mode selects sync for <= 10 URLs ---

  it('auto mode uses sync for small URL count', async () => {
    const res = await mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: 'batch_extract_pages',
        inputs: {
          urls: [fixtureUrl('article.html')],
        },
      },
    });
    const data = parseResult(res);
    expect(res.isError).toBeFalsy();
    // auto mode with 1 URL → sync → returns result directly
    expect(data.status).toBe('succeeded');
    expect(data.mode).toBe('sync');
    expect(data.result).toBeTruthy();
  });
});
