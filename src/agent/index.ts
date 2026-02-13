import * as readline from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BrowserManager, SessionManager } from '../browser/index.js';
import { createBrowserMcpServer } from '../mcp/browser-mcp-server.js';
import { BrowsingAgent } from './agent-loop.js';
import { KnowledgeCardStore } from '../memory/index.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(): Promise<string> {
  return new Promise((resolve) => {
    rl.question('\n> ', (answer) => {
      resolve(answer.trim());
    });
  });
}

let currentAgent: BrowsingAgent | null = null;

process.on('SIGINT', async () => {
  console.log('\n[Agent] 正在清理...');
  if (currentAgent) {
    await currentAgent.cleanup();
    currentAgent = null;
  }
  rl.close();
  process.exit(0);
});

async function main() {
  console.log('AI Browser Agent');
  console.log('输入浏览任务（输入 quit 退出）\n');

  // Launch browser
  const browserManager = new BrowserManager();
  await browserManager.launch();
  const sessionManager = new SessionManager(browserManager);
  const knowledgeStore = new KnowledgeCardStore();

  while (true) {
    const input = await prompt();

    if (!input) continue;
    if (input === 'quit' || input === 'exit') {
      console.log('再见！');
      break;
    }

    // Create MCP Server + Client for this run
    const mcpServer = createBrowserMcpServer(sessionManager, undefined, {
      trustLevel: 'local',
      knowledgeStore,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const mcpClient = new Client({ name: 'cli-agent', version: '0.1.0' });
    await mcpClient.connect(clientTransport);

    const agent = new BrowsingAgent({ mcpClient, knowledgeStore });
    currentAgent = agent;
    let result;
    try {
      result = await agent.run(input);
    } finally {
      currentAgent = null;
      try { await mcpClient.close(); } catch {}
      try { await mcpServer.close(); } catch {}
    }

    console.log('\n---');
    if (result.success) {
      console.log(`[结果] ${result.result}`);
    } else {
      console.log(`[失败] ${result.error}`);
    }
    console.log(`[步数] ${result.iterations}`);
    console.log('---');
  }

  await sessionManager.closeAll();
  await browserManager.close();
  rl.close();
}

main().catch((err) => {
  console.error('启动失败:', err.message);
  process.exit(1);
});
