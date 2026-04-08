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

describe('additional task templates', () => {
  let browserManager: BrowserManager;
  let sessionManager: SessionManager;
  let mcpServer: McpServer;
  let mcpClient: Client;

  beforeAll(async () => {
    browserManager = new BrowserManager();
    await browserManager.launch({ headless: true });
    sessionManager = new SessionManager(browserManager);
  }, 30_000);

  afterAll(async () => {
    await sessionManager.closeAll();
    await browserManager.close();
  }, 30_000);

  beforeEach(async () => {
    mcpServer = createBrowserMcpServer(sessionManager, undefined, {
      trustLevel: 'local',
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(st);
    mcpClient = new Client({ name: 'workflow-test', version: '0.1.0' });
    await mcpClient.connect(ct);
  });

  afterEach(async () => {
    try { await mcpClient.close(); } catch {}
    try { await mcpServer.close(); } catch {}
  });

  it('runs search_extract and opens the selected result', async () => {
    const res = await mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: 'search_extract',
        inputs: {
          startUrl: fixtureUrl('search-flow.html'),
          query: 'browser automation',
          searchField: {
            mode: 'selector',
            selector: '#search-box',
          },
          submit: {
            mode: 'selector',
            selector: '#search-submit',
          },
          openResult: {
            mode: 'selector',
            selector: '.result-link',
          },
          waitForResults: {
            type: 'selector',
            value: '.result-link',
          },
        },
        options: { mode: 'sync' },
      },
    });
    const data = parseResult(res);
    expect(res.isError).toBeFalsy();
    expect(data.status).toBe('succeeded');
    expect(data.result.success).toBe(true);
    expect(data.result.resultOpened).toBe(true);
    expect(data.result.finalPage.title).toBe('Test Article');
  });

  it('runs paginated_extract across multiple pages', async () => {
    const res = await mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: 'paginated_extract',
        inputs: {
          startUrl: fixtureUrl('paginated-1.html'),
          pagination: {
            next: {
              mode: 'selector',
              selector: '.next-link',
            },
            maxPages: 3,
            waitFor: {
              type: 'stable',
            },
          },
        },
        options: { mode: 'sync' },
      },
    });
    const data = parseResult(res);
    expect(res.isError).toBeFalsy();
    expect(data.status).toBe('succeeded');
    expect(data.result.success).toBe(true);
    expect(data.result.pages).toHaveLength(2);
    expect(data.result.pages[0].page.title).toBe('Paginated Page 1');
    expect(data.result.pages[1].page.title).toBe('Paginated Page 2');
    expect(data.result.stoppedReason).toBe('next_unavailable');
  });

  it('runs submit_and_verify and validates success indicator', async () => {
    const res = await mcpClient.callTool({
      name: 'run_task_template',
      arguments: {
        templateId: 'submit_and_verify',
        inputs: {
          startUrl: fixtureUrl('form-submit.html'),
          fields: [
            {
              name: 'email',
              value: 'alice@example.com',
              locator: {
                mode: 'selector',
                selector: '#email',
              },
            },
            {
              name: 'message',
              value: 'Hello world',
              locator: {
                mode: 'selector',
                selector: '#message',
              },
            },
          ],
          submit: {
            mode: 'selector',
            selector: '#submit-btn',
          },
          successIndicator: {
            type: 'textIncludes',
            value: 'Thanks for submitting',
          },
        },
        options: { mode: 'sync' },
      },
    });
    const data = parseResult(res);
    expect(res.isError).toBeFalsy();
    expect(data.status).toBe('succeeded');
    expect(data.result.success).toBe(true);
    expect(data.result.indicatorMatched).toBe(true);
    expect(data.result.finalPage.title).toBe('Submit Success');
  });
});
