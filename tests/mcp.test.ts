import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BrowserManager } from '../src/browser/BrowserManager.js';
import { SessionManager } from '../src/browser/SessionManager.js';
import { createBrowserMcpServer, ErrorCode } from '../src/mcp/browser-mcp-server.js';
import { validateUrl, validateUrlAsync } from '../src/utils/url-validator.js';
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
    sessionManager.setPageEventTrackerOptions({ autoAcceptDelayMs: 3000 });
  });

  afterAll(async () => {
    await sessionManager.closeAll();
    await browserManager.close();
  });

  beforeEach(async () => {
    mcpServer = createBrowserMcpServer(sessionManager, undefined, {
      urlValidation: { allowFile: true },
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

  // Scenario 4: listTools returns all expected tools
  it('Scenario 4: listTools discovers all tools', async () => {
    const { tools } = await mcpClient.listTools();
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual([
      'cancel_task_run', 'click', 'click_and_wait', 'close_session', 'close_tab', 'create_session', 'create_tab',
      'execute_javascript', 'fill_form', 'find_element', 'get_artifact', 'get_console_logs', 'get_dialog_info',
      'get_downloads', 'get_network_logs', 'get_page_content', 'get_page_info',
      'get_runtime_profile', 'get_task_run', 'go_back', 'handle_dialog', 'hover', 'list_tabs',
      'list_task_runs', 'list_task_templates', 'navigate', 'navigate_and_extract', 'press_key',
      'run_task_template', 'screenshot', 'scroll', 'select_option', 'set_value',
      'switch_tab', 'type_text', 'upload_file', 'wait', 'wait_for_stable',
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
    expect(nav.aiSummary).toContain('Navigation');
    expect(nav.aiMarkdown).toContain('## Navigation Result');
    expect(Array.isArray(nav.aiHints)).toBe(true);

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
    expect(err.error).toContain('Protocol not allowed');

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
    expect(info.aiSummary).toContain('interactive elements');
    expect(info.aiMarkdown).toContain('## Page Interaction Snapshot');
    expect(Array.isArray(info.aiHints)).toBe(true);
    expect(info).toHaveProperty('hasMore');
    expect(info).toHaveProperty('nextCursor');

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

  // Scenario 16: default session auto-creation
  it('Scenario 16: navigate without sessionId auto-creates default session', async () => {
    const navRes = await mcpClient.callTool({
      name: 'navigate',
      arguments: { url: fixtureUrl('article.html') },
    });
    const nav = parseResult(navRes);
    expect(nav.success).toBe(true);
    expect(nav.page.title).toBe('Test Article');
  });

  // Scenario 17: structured error codes
  it('Scenario 17: error response includes errorCode', async () => {
    const res = await mcpClient.callTool({
      name: 'get_page_info',
      arguments: { sessionId: 'nonexistent-session-id' },
    });
    expect(res.isError).toBe(true);
    const err = parseResult(res);
    expect(err.errorCode).toBe(ErrorCode.SESSION_NOT_FOUND);
  });

  // Scenario 18: screenshot returns image content
  it('Scenario 18: screenshot returns base64 image', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('article.html') },
    });

    const shotRes = await mcpClient.callTool({
      name: 'screenshot',
      arguments: { sessionId },
    });
    expect(shotRes.content).toBeDefined();
    expect(shotRes.content[0].type).toBe('image');
    expect((shotRes.content[0] as any).mimeType).toBe('image/png');
    expect((shotRes.content[0] as any).data.length).toBeGreaterThan(0);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 19: hover tool
  it('Scenario 19: hover triggers mouseenter event', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('hover.html') },
    });

    const infoRes = await mcpClient.callTool({
      name: 'get_page_info',
      arguments: { sessionId },
    });
    const info = parseResult(infoRes);
    const hoverBtn = info.elements.find((e: any) =>
      e.id?.includes('Hover') || e.label?.includes('Hover')
    );
    expect(hoverBtn).toBeTruthy();

    const hoverRes = await mcpClient.callTool({
      name: 'hover',
      arguments: { sessionId, element_id: hoverBtn.id },
    });
    expect(parseResult(hoverRes).success).toBe(true);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 20: select_option tool
  it('Scenario 20: select_option selects dropdown value', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('select.html') },
    });

    const infoRes = await mcpClient.callTool({
      name: 'get_page_info',
      arguments: { sessionId },
    });
    const info = parseResult(infoRes);
    const selectEl = info.elements.find((e: any) =>
      e.type === 'combobox' || e.id?.includes('select')
    );
    expect(selectEl).toBeTruthy();

    const selectRes = await mcpClient.callTool({
      name: 'select_option',
      arguments: { sessionId, element_id: selectEl.id, value: 'blue' },
    });
    expect(parseResult(selectRes).success).toBe(true);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 21: execute_javascript tool
  it('Scenario 21: execute_javascript runs script and returns result', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('article.html') },
    });

    const jsRes = await mcpClient.callTool({
      name: 'execute_javascript',
      arguments: { sessionId, script: '1 + 2' },
    });
    const jsResult = parseResult(jsRes);
    expect(jsResult.result).toBe(3);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 22: execute_javascript error handling
  it('Scenario 22: execute_javascript returns EXECUTION_ERROR on failure', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('article.html') },
    });

    const jsRes = await mcpClient.callTool({
      name: 'execute_javascript',
      arguments: { sessionId, script: 'throw new Error("test error")' },
    });
    expect(jsRes.isError).toBe(true);
    const err = parseResult(jsRes);
    expect(err.errorCode).toBe(ErrorCode.EXECUTION_ERROR);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 23: Tab management tools
  it('Scenario 23: create_tab, list_tabs, switch_tab, close_tab', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    // Create a new tab
    const tabRes = await mcpClient.callTool({
      name: 'create_tab',
      arguments: { sessionId, url: fixtureUrl('article.html') },
    });
    const tab = parseResult(tabRes);
    expect(tab.tabId).toBeTruthy();

    // List tabs
    const listRes = await mcpClient.callTool({
      name: 'list_tabs',
      arguments: { sessionId },
    });
    const list = parseResult(listRes);
    expect(list.tabs.length).toBe(2);
    expect(list.aiSummary).toContain('tabs');
    expect(list.aiMarkdown).toContain('## Tab List');
    expect(Array.isArray(list.aiHints)).toBe(true);
    expect(Array.isArray(list.nextActions)).toBe(true);
    expect(list.hasMore).toBe(false);
    expect(list.nextCursor).toBeNull();

    // Switch tab
    const switchRes = await mcpClient.callTool({
      name: 'switch_tab',
      arguments: { sessionId, tabId: tab.tabId },
    });
    expect(parseResult(switchRes).success).toBe(true);

    // Close tab
    const closeTabRes = await mcpClient.callTool({
      name: 'close_tab',
      arguments: { sessionId, tabId: tab.tabId },
    });
    expect(parseResult(closeTabRes).success).toBe(true);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 24: wait with networkidle condition
  it('Scenario 24: wait networkidle condition', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('article.html') },
    });

    const waitRes = await mcpClient.callTool({
      name: 'wait',
      arguments: { sessionId, condition: 'networkidle', milliseconds: 5000 },
    });
    expect(parseResult(waitRes).success).toBe(true);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 25: get_page_info maxElements limit
  it('Scenario 25: get_page_info respects maxElements', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('login.html') },
    });

    const infoRes = await mcpClient.callTool({
      name: 'get_page_info',
      arguments: { sessionId, maxElements: 2 },
    });
    const info = parseResult(infoRes);
    expect(info.elements.length).toBeLessThanOrEqual(2);
    expect(typeof info.totalElements).toBe('number');
    expect(typeof info.truncated).toBe('boolean');

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 26: get_page_info visibleOnly filter
  it('Scenario 26: get_page_info visibleOnly=false returns all elements', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('login.html') },
    });

    const allRes = await mcpClient.callTool({
      name: 'get_page_info',
      arguments: { sessionId, visibleOnly: false, maxElements: 100 },
    });
    const allInfo = parseResult(allRes);

    const visibleRes = await mcpClient.callTool({
      name: 'get_page_info',
      arguments: { sessionId, visibleOnly: true, maxElements: 100 },
    });
    const visibleInfo = parseResult(visibleRes);

    // visibleOnly=false should return >= visibleOnly=true
    expect(allInfo.totalElements).toBeGreaterThanOrEqual(visibleInfo.totalElements);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 27: get_page_content maxLength truncation
  it('Scenario 27: get_page_content respects maxLength', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('article.html') },
    });

    const contentRes = await mcpClient.callTool({
      name: 'get_page_content',
      arguments: { sessionId, maxLength: 50 },
    });
    const content = parseResult(contentRes);
    const totalText = (content.sections || []).map((s: any) => s.text).join('');
    expect(totalText.length).toBeLessThanOrEqual(50);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 28: navigate returns statusCode
  it('Scenario 28: navigate returns statusCode', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    const navRes = await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('article.html') },
    });
    const nav = parseResult(navRes);
    expect(nav.success).toBe(true);
    expect(nav).toHaveProperty('statusCode');

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 29: sensitive field masking
  it('Scenario 29: get_page_info masks password field values', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('login.html') },
    });

    // First get elements to find the password field
    const infoRes1 = await mcpClient.callTool({
      name: 'get_page_info',
      arguments: { sessionId, visibleOnly: false, maxElements: 100 },
    });
    const info1 = parseResult(infoRes1);
    const pwField = info1.elements.find((e: any) =>
      (e.id || '').toLowerCase().includes('password') ||
      (e.label || '').toLowerCase().includes('password')
    );

    if (pwField) {
      // Type a value into the password field
      await mcpClient.callTool({
        name: 'type_text',
        arguments: { sessionId, element_id: pwField.id, text: 'secret123' },
      });

      // Re-fetch page info and verify masking
      const infoRes2 = await mcpClient.callTool({
        name: 'get_page_info',
        arguments: { sessionId, visibleOnly: false, maxElements: 100 },
      });
      const info2 = parseResult(infoRes2);
      const pwField2 = info2.elements.find((e: any) =>
        (e.id || '').toLowerCase().includes('password') ||
        (e.label || '').toLowerCase().includes('password')
      );
      if (pwField2?.state?.value) {
        expect(pwField2.state.value).toBe('********');
      }
    }

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 30: execute_javascript truncation for large results
  it('Scenario 30: execute_javascript truncates large return values', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('article.html') },
    });

    const jsRes = await mcpClient.callTool({
      name: 'execute_javascript',
      arguments: { sessionId, script: '"x".repeat(5000)' },
    });
    const jsResult = parseResult(jsRes);
    expect(jsResult.truncated).toBe(true);
    expect(typeof jsResult.result).toBe('string');
    expect(jsResult.result).toContain('(truncated)');

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // ===== P1-1: ELEMENT_NOT_FOUND hint tests =====

  // Scenario 31: ELEMENT_NOT_FOUND error includes hint field
  it('Scenario 31: ELEMENT_NOT_FOUND error includes hint', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('article.html') },
    });

    const clickRes = await mcpClient.callTool({
      name: 'click',
      arguments: { sessionId, element_id: 'btn_nonexistent_99999' },
    });
    expect(clickRes.isError).toBe(true);
    const err = parseResult(clickRes);
    expect(err.errorCode).toBe(ErrorCode.ELEMENT_NOT_FOUND);
    expect(err.hint).toBe('Element IDs expire after navigation or DOM changes. Call get_page_info to refresh.');

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 32: Non-ELEMENT_NOT_FOUND errors do not include hint
  it('Scenario 32: non-ELEMENT_NOT_FOUND error has no hint', async () => {
    const res = await mcpClient.callTool({
      name: 'get_page_info',
      arguments: { sessionId: 'nonexistent-session-id' },
    });
    expect(res.isError).toBe(true);
    const err = parseResult(res);
    expect(err.errorCode).toBe(ErrorCode.SESSION_NOT_FOUND);
    expect(err.hint).toBeUndefined();
  });

  // ===== P1-3: Combo key tests =====

  // Scenario 33: Ctrl+A combo key executes successfully
  it('Scenario 33: Ctrl+A combo key works', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('form.html') },
    });

    const res = await mcpClient.callTool({
      name: 'press_key',
      arguments: { sessionId, key: 'a', modifiers: ['Control'] },
    });
    const result = parseResult(res);
    expect(result.success).toBe(true);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 34: Ctrl+W combo key is blocked
  it('Scenario 34: Ctrl+W combo is rejected', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('article.html') },
    });

    const res = await mcpClient.callTool({
      name: 'press_key',
      arguments: { sessionId, key: 'w', modifiers: ['Control'] },
    });
    expect(res.isError).toBe(true);
    const err = parseResult(res);
    expect(err.error).toContain('不允许的组合键');

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 35: Shift+Tab combo key works
  it('Scenario 35: Shift+Tab combo works', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('form.html') },
    });

    const res = await mcpClient.callTool({
      name: 'press_key',
      arguments: { sessionId, key: 'Tab', modifiers: ['Shift'] },
    });
    const r = parseResult(res);
    expect(r.success).toBe(true);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 36: Single key mode backward compatible
  it('Scenario 36: single key mode still works without modifiers', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('article.html') },
    });

    const res = await mcpClient.callTool({
      name: 'press_key',
      arguments: { sessionId, key: 'Enter' },
    });
    const r = parseResult(res);
    expect(r.success).toBe(true);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // ===== P2-1: Screenshot parameter tests =====

  // Scenario 37: screenshot fullPage parameter
  it('Scenario 37: screenshot fullPage captures full page', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('long-page.html') },
    });

    const shotRes = await mcpClient.callTool({
      name: 'screenshot',
      arguments: { sessionId, fullPage: true },
    });
    expect(shotRes.content[0].type).toBe('image');
    expect((shotRes.content[0] as any).mimeType).toBe('image/png');
    expect((shotRes.content[0] as any).data.length).toBeGreaterThan(0);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 38: screenshot format/quality parameters
  it('Scenario 38: screenshot jpeg format with quality', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('article.html') },
    });

    const shotRes = await mcpClient.callTool({
      name: 'screenshot',
      arguments: { sessionId, format: 'jpeg', quality: 50 },
    });
    expect(shotRes.content[0].type).toBe('image');
    expect((shotRes.content[0] as any).mimeType).toBe('image/jpeg');
    expect((shotRes.content[0] as any).data.length).toBeGreaterThan(0);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 39: screenshot element_id parameter
  it('Scenario 39: screenshot element_id captures element', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('login.html') },
    });

    // Get elements to find a button
    const infoRes = await mcpClient.callTool({
      name: 'get_page_info',
      arguments: { sessionId },
    });
    const info = parseResult(infoRes);
    const btn = info.elements.find((e: any) => e.type === 'button');
    expect(btn).toBeTruthy();

    const shotRes = await mcpClient.callTool({
      name: 'screenshot',
      arguments: { sessionId, element_id: btn.id },
    });
    expect(shotRes.content[0].type).toBe('image');
    expect((shotRes.content[0] as any).data.length).toBeGreaterThan(0);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 40: screenshot element_id not found returns error
  it('Scenario 40: screenshot element_id not found returns error', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('article.html') },
    });

    const shotRes = await mcpClient.callTool({
      name: 'screenshot',
      arguments: { sessionId, element_id: 'btn_nonexistent_99999' },
    });
    expect(shotRes.isError).toBe(true);
    const err = parseResult(shotRes);
    expect(err.errorCode).toBe(ErrorCode.ELEMENT_NOT_FOUND);
    expect(err.hint).toBeDefined();

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // ===== P2-2: set_value tests =====

  // Scenario 41: set_value sets input value
  it('Scenario 41: set_value sets input value', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('richtext.html') },
    });

    const infoRes = await mcpClient.callTool({
      name: 'get_page_info',
      arguments: { sessionId, visibleOnly: false, maxElements: 100 },
    });
    const info = parseResult(infoRes);
    const input = info.elements.find((e: any) =>
      e.id?.includes('input') || e.id?.includes('Plain_Input') || e.type === 'input'
    );
    expect(input).toBeTruthy();

    const setRes = await mcpClient.callTool({
      name: 'set_value',
      arguments: { sessionId, element_id: input.id, value: 'Hello World' },
    });
    expect(parseResult(setRes).success).toBe(true);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 42: set_value sets contenteditable content
  it('Scenario 42: set_value sets contenteditable content', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('richtext.html') },
    });

    const infoRes = await mcpClient.callTool({
      name: 'get_page_info',
      arguments: { sessionId, visibleOnly: false, maxElements: 100 },
    });
    const info = parseResult(infoRes);
    // Find the contenteditable element
    const editor = info.elements.find((e: any) =>
      e.id?.includes('richEditor') || e.id?.includes('Rich') || e.id?.includes('textbox')
    );
    expect(editor).toBeTruthy();

    const setRes = await mcpClient.callTool({
      name: 'set_value',
      arguments: { sessionId, element_id: editor.id, value: 'New plain text content' },
    });
    expect(parseResult(setRes).success).toBe(true);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 43: set_value isHtml mode
  it('Scenario 43: set_value isHtml mode', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('richtext.html') },
    });

    const infoRes = await mcpClient.callTool({
      name: 'get_page_info',
      arguments: { sessionId, visibleOnly: false, maxElements: 100 },
    });
    const info = parseResult(infoRes);
    const editor = info.elements.find((e: any) =>
      e.id?.includes('richEditor') || e.id?.includes('Rich') || e.id?.includes('textbox')
    );
    expect(editor).toBeTruthy();

    const setRes = await mcpClient.callTool({
      name: 'set_value',
      arguments: {
        sessionId,
        element_id: editor.id,
        value: '<b>Bold</b> and <i>italic</i>',
        isHtml: true,
      },
    });
    expect(parseResult(setRes).success).toBe(true);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // ===== P0: Dialog tests =====

  // Scenario 44: get_dialog_info returns empty when no dialog
  it('Scenario 44: get_dialog_info returns empty when no dialog', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('article.html') },
    });

    const res = await mcpClient.callTool({
      name: 'get_dialog_info',
      arguments: { sessionId },
    });
    const info = parseResult(res);
    expect(info.pendingDialog).toBeNull();
    expect(info.dialogHistory).toEqual([]);
    expect(info.aiSummary).toContain('pending=no');
    expect(info.aiMarkdown).toContain('## Dialog Status');
    expect(info.hasMore).toBe(false);
    expect(info.nextCursor).toBeNull();

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 45: alert auto-accepted, appears in history
  it('Scenario 45: alert auto-accepted appears in history', { timeout: 10000 }, async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('dialog.html') },
    });

    // Trigger alert via JS
    await mcpClient.callTool({
      name: 'execute_javascript',
      arguments: { sessionId, script: 'document.getElementById("alert-btn").click()' },
    });

    // Wait for auto-accept (default delay is 3000ms)
    await new Promise(r => setTimeout(r, 3500));

    const res = await mcpClient.callTool({
      name: 'get_dialog_info',
      arguments: { sessionId },
    });
    const info = parseResult(res);
    expect(info.dialogHistory.length).toBeGreaterThanOrEqual(1);
    const last = info.dialogHistory[info.dialogHistory.length - 1];
    expect(last.type).toBe('alert');
    expect(last.message).toBe('Hello!');
    expect(last.handled).toBe(true);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 46: handle_dialog accept confirm
  it('Scenario 46: handle_dialog accept confirm', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('dialog.html') },
    });

    // Trigger confirm - use page.evaluate to click so dialog appears
    // We need to handle it before auto-accept kicks in
    const clickPromise = mcpClient.callTool({
      name: 'execute_javascript',
      arguments: { sessionId, script: 'document.getElementById("confirm-btn").click(); true' },
    });

    // Small delay then handle
    await new Promise(r => setTimeout(r, 50));

    const handleRes = await mcpClient.callTool({
      name: 'handle_dialog',
      arguments: { sessionId, action: 'accept' },
    });
    const handled = parseResult(handleRes);
    expect(handled.success).toBe(true);
    expect(handled.dialog.type).toBe('confirm');

    await clickPromise;
    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 47: handle_dialog dismiss confirm
  it('Scenario 47: handle_dialog dismiss confirm', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('dialog.html') },
    });

    const clickPromise = mcpClient.callTool({
      name: 'execute_javascript',
      arguments: { sessionId, script: 'document.getElementById("confirm-btn").click(); true' },
    });

    await new Promise(r => setTimeout(r, 50));

    const handleRes = await mcpClient.callTool({
      name: 'handle_dialog',
      arguments: { sessionId, action: 'dismiss' },
    });
    const handled = parseResult(handleRes);
    expect(handled.success).toBe(true);

    await clickPromise;
    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 48: handle_dialog provides text for prompt
  it('Scenario 48: handle_dialog provides text for prompt', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('dialog.html') },
    });

    const clickPromise = mcpClient.callTool({
      name: 'execute_javascript',
      arguments: { sessionId, script: 'document.getElementById("prompt-btn").click(); true' },
    });

    await new Promise(r => setTimeout(r, 50));

    const handleRes = await mcpClient.callTool({
      name: 'handle_dialog',
      arguments: { sessionId, action: 'accept', text: 'Claude' },
    });
    const handled = parseResult(handleRes);
    expect(handled.success).toBe(true);
    expect(handled.dialog.type).toBe('prompt');

    await clickPromise;
    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // ===== P0: Popup tests =====

  // Scenario 49: click window.open button captures popup as new tab
  it('Scenario 49: click window.open captures popup as new tab', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('popup.html') },
    });

    const infoRes = await mcpClient.callTool({
      name: 'get_page_info',
      arguments: { sessionId },
    });
    const info = parseResult(infoRes);
    // Find the window.open button
    const openBtn = info.elements.find((e: any) =>
      e.id?.includes('Window') || e.label?.includes('Window.open')
    );
    expect(openBtn).toBeTruthy();

    const clickRes = await mcpClient.callTool({
      name: 'click',
      arguments: { sessionId, element_id: openBtn.id },
    });
    const clicked = parseResult(clickRes);
    expect(clicked.success).toBe(true);

    // List tabs - should have 2 (original + popup)
    const listRes = await mcpClient.callTool({
      name: 'list_tabs',
      arguments: { sessionId },
    });
    const list = parseResult(listRes);
    expect(list.tabs.length).toBe(2);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // ===== P1: Stability tests =====

  // Scenario 50: get_page_info includes stability info after navigate
  it('Scenario 50: get_page_info includes stability info', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('article.html') },
    });

    const infoRes = await mcpClient.callTool({
      name: 'get_page_info',
      arguments: { sessionId },
    });
    const info = parseResult(infoRes);
    expect(info.stability).toBeDefined();
    expect(typeof info.stability.stable).toBe('boolean');
    expect(typeof info.stability.domStable).toBe('boolean');
    expect(typeof info.stability.networkPending).toBe('number');
    expect(info.stability.loadState).toBeDefined();

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 51: wait_for_stable on static page returns stable=true
  it('Scenario 51: wait_for_stable static page returns stable', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('article.html') },
    });

    // Wait a bit for page to settle
    await new Promise(r => setTimeout(r, 600));

    const res = await mcpClient.callTool({
      name: 'wait_for_stable',
      arguments: { sessionId, timeout: 3000 },
    });
    const result = parseResult(res);
    expect(result.stable).toBe(true);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 52: wait_for_stable on dynamic page waits then returns stable
  it('Scenario 52: wait_for_stable dynamic page eventually stable', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('dynamic.html') },
    });

    const res = await mcpClient.callTool({
      name: 'wait_for_stable',
      arguments: { sessionId, timeout: 5000, quietMs: 500 },
    });
    const result = parseResult(res);
    expect(result.stable).toBe(true);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // ===== P1: Network log tests =====

  // Scenario 53: get_network_logs returns navigation request
  it('Scenario 53: get_network_logs returns navigation request', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('article.html') },
    });

    const res = await mcpClient.callTool({
      name: 'get_network_logs',
      arguments: { sessionId },
    });
    const result = parseResult(res);
    expect(result.logs.length).toBeGreaterThan(0);
    expect(result.totalCount).toBeGreaterThan(0);
    expect(result.aiSummary).toContain('Network logs');
    expect(result.aiMarkdown).toContain('## Network Logs');
    expect(Array.isArray(result.topIssues)).toBe(true);
    expect(result).toHaveProperty('hasMore');
    expect(result).toHaveProperty('nextCursor');

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 54: get_network_logs filter=xhr
  it('Scenario 54: get_network_logs filter=xhr returns only XHR/Fetch', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('article.html') },
    });

    const res = await mcpClient.callTool({
      name: 'get_network_logs',
      arguments: { sessionId, filter: 'xhr' },
    });
    const result = parseResult(res);
    // Static page has no XHR, so should be empty
    for (const log of result.logs) {
      expect(log.isXHR).toBe(true);
    }

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 55: get_network_logs urlPattern filter
  it('Scenario 55: get_network_logs urlPattern filter', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('article.html') },
    });

    const res = await mcpClient.callTool({
      name: 'get_network_logs',
      arguments: { sessionId, urlPattern: 'article.html' },
    });
    const result = parseResult(res);
    for (const log of result.logs) {
      expect(log.url).toMatch(/article\.html/);
    }

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // ===== P2: Console log tests =====

  // Scenario 56: get_console_logs captures error and warn
  it('Scenario 56: get_console_logs captures error and warn', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('console.html') },
    });

    // Wait for console messages to be captured
    await new Promise(r => setTimeout(r, 300));

    const res = await mcpClient.callTool({
      name: 'get_console_logs',
      arguments: { sessionId },
    });
    const result = parseResult(res);
    // Default filter is error+warn
    expect(result.logs.length).toBeGreaterThanOrEqual(2);
    expect(result.aiSummary).toContain('Console logs');
    expect(result.aiMarkdown).toContain('## Console Logs');
    expect(Array.isArray(result.topIssues)).toBe(true);
    expect(result).toHaveProperty('hasMore');
    expect(result).toHaveProperty('nextCursor');
    const levels = result.logs.map((l: any) => l.level);
    expect(levels).toContain('error');
    expect(levels).toContain('warn');

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 57: get_console_logs level=all returns all levels
  it('Scenario 57: get_console_logs level=all returns all levels', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('console.html') },
    });

    await new Promise(r => setTimeout(r, 300));

    const res = await mcpClient.callTool({
      name: 'get_console_logs',
      arguments: { sessionId, level: 'all' },
    });
    const result = parseResult(res);
    expect(result.logs.length).toBeGreaterThanOrEqual(3);
    const levels = result.logs.map((l: any) => l.level);
    expect(levels).toContain('log');

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // ===== P2: Upload tests =====

  // Scenario 58: upload_file uploads file successfully
  it('Scenario 58: upload_file uploads file successfully', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('upload.html') },
    });

    const infoRes = await mcpClient.callTool({
      name: 'get_page_info',
      arguments: { sessionId, visibleOnly: false, maxElements: 100 },
    });
    const info = parseResult(infoRes);
    const fileInput = info.elements.find((e: any) =>
      e.id?.includes('fileInput') || e.id?.includes('Upload') || e.type === 'input'
    );
    expect(fileInput).toBeTruthy();

    // Upload the article.html fixture as a test file
    const testFilePath = path.resolve('tests/fixtures/article.html');
    const uploadRes = await mcpClient.callTool({
      name: 'upload_file',
      arguments: { sessionId, element_id: fileInput.id, filePath: testFilePath },
    });
    const uploaded = parseResult(uploadRes);
    expect(uploaded.success).toBe(true);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Scenario 59: upload_file returns error for non-existent file
  it('Scenario 59: upload_file returns error for non-existent file', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('upload.html') },
    });

    const infoRes = await mcpClient.callTool({
      name: 'get_page_info',
      arguments: { sessionId, visibleOnly: false, maxElements: 100 },
    });
    const info = parseResult(infoRes);
    const fileInput = info.elements.find((e: any) =>
      e.id?.includes('fileInput') || e.id?.includes('Upload') || e.type === 'input'
    );
    expect(fileInput).toBeTruthy();

    const uploadRes = await mcpClient.callTool({
      name: 'upload_file',
      arguments: { sessionId, element_id: fileInput.id, filePath: '/nonexistent/file.txt' },
    });
    expect(uploadRes.isError).toBe(true);
    const err = parseResult(uploadRes);
    expect(err.error).toContain('File not found');

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // ===== P2: Download tests =====

  // Scenario 60: get_downloads returns empty list
  it('Scenario 60: get_downloads returns empty list', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: fixtureUrl('article.html') },
    });

    const res = await mcpClient.callTool({
      name: 'get_downloads',
      arguments: { sessionId },
    });
    const result = parseResult(res);
    expect(Array.isArray(result.downloads)).toBe(true);
    expect(result.downloads.length).toBe(0);

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });
});

// ============================================================
// Part 3: Security tests — TrustLevel, tool gating, DNS check
// ============================================================

describe('validateUrlAsync', () => {
  it('blocks localhost via DNS when blockPrivate=true', async () => {
    const result = await validateUrlAsync('http://localhost:8080', { blockPrivate: true });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('private');
    }
  });

  it('allows public URL when blockPrivate=true', async () => {
    const result = await validateUrlAsync('https://example.com', { blockPrivate: true });
    expect(result.valid).toBe(true);
  });

  it('passes through when blockPrivate=false', async () => {
    const result = await validateUrlAsync('http://localhost:8080', { blockPrivate: false });
    expect(result.valid).toBe(true);
  });

  it('blocks IP literal 127.0.0.1 via sync check', async () => {
    const result = await validateUrlAsync('http://127.0.0.1:8080', { blockPrivate: true });
    expect(result.valid).toBe(false);
  });
});

describe('MCP Remote Mode (trustLevel=remote)', () => {
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
      trustLevel: 'remote',
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(st);
    mcpClient = new Client({ name: 'test-remote', version: '0.1.0' });
    await mcpClient.connect(ct);
  });

  afterEach(async () => {
    try { await mcpClient.close(); } catch {}
    try { await mcpServer.close(); } catch {}
  });

  // Remote mode: upload_file returns error
  it('upload_file is disabled in remote mode', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    const res = await mcpClient.callTool({
      name: 'upload_file',
      arguments: { sessionId, element_id: 'test', filePath: '/tmp/test.txt' },
    });
    expect(res.isError).toBe(true);
    const err = parseResult(res);
    expect(err.error).toContain('disabled in remote mode');

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Remote mode: execute_javascript returns error
  it('execute_javascript is disabled in remote mode', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    const res = await mcpClient.callTool({
      name: 'execute_javascript',
      arguments: { sessionId, script: '1+1' },
    });
    expect(res.isError).toBe(true);
    const err = parseResult(res);
    expect(err.error).toContain('disabled in remote mode');

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Remote mode: navigate to localhost is blocked
  it('navigate to localhost is blocked in remote mode', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    const res = await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: 'http://localhost:8080' },
    });
    expect(res.isError).toBe(true);
    const err = parseResult(res);
    expect(err.error).toContain('private');

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });

  // Remote mode: navigate to 127.0.0.1 is blocked
  it('navigate to 127.0.0.1 is blocked in remote mode', async () => {
    const createRes = await mcpClient.callTool({ name: 'create_session', arguments: {} });
    const { sessionId } = parseResult(createRes);

    const res = await mcpClient.callTool({
      name: 'navigate',
      arguments: { sessionId, url: 'http://127.0.0.1:3000' },
    });
    expect(res.isError).toBe(true);
    const err = parseResult(res);
    expect(err.error).toContain('private');

    await mcpClient.callTool({ name: 'close_session', arguments: { sessionId } });
  });
});

// ============================================================
// Part 4: close_session no-op + defaultSessionPromise retry
// ============================================================

describe('MCP Session Edge Cases', () => {
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

  // close_session without sessionId and no default session returns no-op
  it('close_session returns no-op when no active session', async () => {
    const mcpServer = createBrowserMcpServer(sessionManager, undefined, {
      trustLevel: 'local',
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(st);
    const mcpClient = new Client({ name: 'test-noop', version: '0.1.0' });
    await mcpClient.connect(ct);

    // Call close_session without ever creating a session
    const res = await mcpClient.callTool({
      name: 'close_session',
      arguments: {},
    });
    const result = parseResult(res);
    expect(result.success).toBe(true);
    expect(result.reason).toContain('No active session');

    try { await mcpClient.close(); } catch {}
    try { await mcpServer.close(); } catch {}
  });
});