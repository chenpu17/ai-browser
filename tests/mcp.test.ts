import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BrowserManager } from '../src/browser/BrowserManager.js';
import { SessionManager } from '../src/browser/SessionManager.js';
import { createBrowserMcpServer } from '../src/mcp/browser-mcp-server.js';
import { escapeCSS, generateElementId, executeAction } from '../src/browser/actions.js';

// Helper: fixture file URL
function fixtureUrl(name: string): string {
  return `file://${path.resolve('tests/fixtures', name)}`;
}

// Helper: parse MCP tool result text
function parseResult(result: any): any {
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

// ============================================================
// Part 1: actions.ts unit tests (Scenarios 1-3)
// ============================================================
describe('actions.ts', () => {
  // Scenario 1: escapeCSS
  it('Scenario 1: escapeCSS escapes quotes and backslashes', () => {
    expect(escapeCSS('hello')).toBe('hello');
    expect(escapeCSS('a"b')).toBe('a\\"b');
    expect(escapeCSS('a\\b')).toBe('a\\\\b');
    expect(escapeCSS('a"b\\c"d')).toBe('a\\"b\\\\c\\"d');
  });

  // Scenario 2: generateElementId
  it('Scenario 2: generateElementId produces correct IDs', () => {
    const node1 = { role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 42 };
    expect(generateElementId(node1)).toBe('btn_Submit_42');

    const node2 = { role: { value: 'link' }, name: { value: 'Click Here' }, backendDOMNodeId: 7 };
    expect(generateElementId(node2)).toBe('link_Click_Here_7');

    // Unknown role, no name
    const node3 = { role: { value: 'slider' }, name: { value: '' }, backendDOMNodeId: 0 };
    expect(generateElementId(node3)).toBe('slider_unnamed_0');

    // Missing fields
    const node4 = {};
    expect(generateElementId(node4)).toBe('unknown_unnamed_0');
  });

  // Scenario 3: executeAction rejects unknown actions
  it('Scenario 3: executeAction throws on unknown action', async () => {
    const fakePage = {} as any;
    await expect(executeAction(fakePage, 'fly')).rejects.toThrow('Unknown action: fly');
  });
});

// ============================================================
// Part 2: MCP Server tests (Scenarios 4-15)
// ============================================================
describe('MCP Browser Server', () => {
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
    mcpServer = createBrowserMcpServer(sessionManager);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(st);
    mcpClient = new Client({ name: 'test', version: '0.1.0' });
    await mcpClient.connect(ct);
  });

  afterEach(async () => {
    try { await mcpClient.close(); } catch {}
    try { await mcpServer.close(); } catch {}
  });

  // Scenario 4: listTools returns all expected tools
  it('Scenario 4: listTools discovers all 12 tools', async () => {
    const { tools } = await mcpClient.listTools();
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual([
      'click', 'close_session', 'create_session',
      'find_element', 'get_page_content', 'get_page_info',
      'go_back', 'navigate', 'press_key', 'scroll', 'type_text', 'wait',
    ]);
  });

  // Scenario 5: create_session + close_session lifecycle
  it('Scenario 5: create and close session', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const created = parseResult(createRes);
    expect(created.sessionId).toBeTruthy();

    const closeRes = await mcpClient.callTool({
      name: 'close_session',
      arguments: { sessionId: created.sessionId },
    });
    const closed = parseResult(closeRes);
    expect(closed.success).toBe(true);
  });

  // Scenario 6: navigate to local file
  it('Scenario 6: navigate to local fixture file', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    const navRes = await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('article.html') },
    });
    const nav = parseResult(navRes);
    expect(nav.success).toBe(true);
    expect(nav.page.title).toBe('Test Article');

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 7: navigate rejects invalid URL protocol
  it('Scenario 7: navigate rejects javascript: URL', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    const navRes = await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: 'javascript:alert(1)' },
    });
    expect(navRes.isError).toBe(true);
    const err = parseResult(navRes);
    expect(err.error).toContain('Only http/https/file');

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 8: navigate rejects malformed URL
  it('Scenario 8: navigate rejects malformed URL', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    const navRes = await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: 'not-a-url' },
    });
    expect(navRes.isError).toBe(true);
    const err = parseResult(navRes);
    expect(err.error).toContain('Invalid URL');

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 9: get_page_info returns elements and page metadata
  it('Scenario 9: get_page_info returns structured data', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('login.html') },
    });

    const infoRes = await mcpClient.callTool({
      name: 'get_page_info',
      arguments: { sessionId },
    });
    const info = parseResult(infoRes);
    expect(info.page.title).toBe('Login Page');
    expect(info.page.type).toBe('login');
    expect(Array.isArray(info.elements)).toBe(true);
    expect(info.elements.length).toBeGreaterThan(0);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 10: get_page_content extracts text
  it('Scenario 10: get_page_content extracts page text', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('article.html') },
    });

    const contentRes = await mcpClient.callTool({
      name: 'get_page_content',
      arguments: { sessionId },
    });
    const content = parseResult(contentRes);
    const allText = (content.sections || []).map((s: any) => s.text).join(' ');
    expect(allText).toContain('Article Title');

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 11: type_text into input field
  it('Scenario 11: type_text types into input', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('form.html') },
    });

    // Get elements to find the name input
    const infoRes = await mcpClient.callTool({
      name: 'get_page_info',
      arguments: { sessionId },
    });
    const info = parseResult(infoRes);
    const nameInput = info.elements.find((e: any) =>
      e.type === 'input' || e.id?.includes('name') || e.id?.includes('input')
    );
    expect(nameInput).toBeTruthy();

    const typeRes = await mcpClient.callTool({
      name: 'type_text',
      arguments: { sessionId, element_id: nameInput.id, text: 'Test User' },
    });
    const typed = parseResult(typeRes);
    expect(typed.success).toBe(true);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 12: scroll down and up
  it('Scenario 12: scroll down and up', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('long-page.html') },
    });

    const downRes = await mcpClient.callTool({
      name: 'scroll',
      arguments: { sessionId, direction: 'down' },
    });
    expect(parseResult(downRes).success).toBe(true);

    const upRes = await mcpClient.callTool({
      name: 'scroll',
      arguments: { sessionId, direction: 'up' },
    });
    expect(parseResult(upRes).success).toBe(true);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 13: find_element fuzzy match
  it('Scenario 13: find_element returns candidates', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('login.html') },
    });

    const findRes = await mcpClient.callTool({
      name: 'find_element',
      arguments: { sessionId, query: 'login button' },
    });
    const found = parseResult(findRes);
    expect(found.query).toBe('login button');
    expect(Array.isArray(found.candidates)).toBe(true);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 14: wait with milliseconds
  it('Scenario 14: wait pauses execution', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('article.html') },
    });

    const start = Date.now();
    const waitRes = await mcpClient.callTool({
      name: 'wait',
      arguments: { sessionId, milliseconds: 200 },
    });
    const elapsed = Date.now() - start;
    expect(parseResult(waitRes).success).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(150); // allow some tolerance

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 15: safe() wrapper catches errors for invalid session
  it('Scenario 15: tools return error for invalid sessionId', async () => {
    const res = await mcpClient.callTool({
      name: 'get_page_info',
      arguments: { sessionId: 'nonexistent-session-id' },
    });
    expect(res.isError).toBe(true);
    const err = parseResult(res);
    expect(err.error).toBeTruthy();
  });
});
