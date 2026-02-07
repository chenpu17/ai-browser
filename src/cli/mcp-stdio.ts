#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BrowserManager, SessionManager } from '../browser/index.js';
import { createBrowserMcpServer } from '../mcp/browser-mcp-server.js';
import { CookieStore } from '../browser/CookieStore.js';

async function main() {
  // 将日志输出到 stderr，避免干扰 stdio 通信
  const log = (...args: unknown[]) => console.error('[ai-browser-mcp]', ...args);

  log('Starting browser...');
  const browserManager = new BrowserManager();
  await browserManager.launch();

  const sessionManager = new SessionManager(browserManager);
  const cookieStore = new CookieStore();
  sessionManager.setCookieStore(cookieStore);

  log('Creating MCP server...');
  const mcpServer = createBrowserMcpServer(sessionManager, cookieStore, {
    urlValidation: { allowFile: true },
  });

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  log('MCP server connected via stdio. Ready for requests.');

  // 优雅关闭
  const shutdown = async () => {
    log('Shutting down...');
    await mcpServer.close();
    await sessionManager.closeAll();
    await browserManager.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[ai-browser-mcp] Fatal error:', err);
  process.exit(1);
});
