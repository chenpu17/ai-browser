# AI Browser

An AI-friendly browser automation service. It extracts structured semantic information from web pages and exposes browser tools via the MCP (Model Context Protocol), enabling LLM agents to browse and interact with the web efficiently.

[中文文档](./README_CN.md)

## Install

```bash
npm install -g ai-browser
```

This provides two commands:

| Command | Description |
|---------|-------------|
| `ai-browser` | Start the HTTP server (Web UI + REST API + SSE MCP endpoint) |
| `ai-browser-mcp` | Start a stdio MCP server for Claude Desktop / Cursor |

## Quick Start

### 1. Start the server

```bash
ai-browser
# or specify a port
ai-browser --port 8080
```

Open `http://localhost:3000` — the homepage provides a semantic analysis demo and a link to the built-in test Agent.

### 2. Configure the test Agent

Click **Settings** in the Agent page to set your LLM API key, base URL, and model. The Agent supports any OpenAI-compatible API.

### 3. Use with Claude Desktop (stdio MCP)

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ai-browser": {
      "command": "ai-browser-mcp"
    }
  }
}
```

### 4. Use with remote MCP clients (SSE)

```bash
ai-browser --port 3000
# SSE endpoint: http://localhost:3000/mcp/sse
# Message endpoint: http://localhost:3000/mcp/message?sessionId=xxx
```

### 5. Use as a library

```typescript
import {
  createBrowserMcpServer,
  BrowserManager,
  SessionManager,
  BrowsingAgent,
} from 'ai-browser';
```

## Features

- **Semantic Web Analysis** — Extracts interactive elements (buttons, links, inputs) from pages using the Chrome Accessibility Tree, assigning each a unique semantic ID
- **MCP Protocol** — Browser tools exposed via MCP with both stdio and SSE transports
- **LLM-Powered Agent** — Built-in autonomous browsing agent driven by LLM tool calls
- **Headless / Headful Switching** — Start in headful mode for manual login, then switch to headless for automation while preserving cookies
- **Real-time Monitoring** — Web UI with SSE-based live streaming of agent actions and results
- **Multi-Session & Multi-Tab** — Concurrent browser sessions with up to 20 tabs each, automatic cleanup on expiration

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                       AI Browser                          │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  CLI Layer (src/cli/)                                    │
│    ai-browser ──→ Fastify HTTP + SSE MCP                 │
│    ai-browser-mcp ──→ stdio MCP                          │
│                                                          │
│  API Layer (src/api/)                                    │
│    REST API (/v1/sessions, /v1/agent, ...)               │
│    SSE MCP  (/mcp/sse, /mcp/message)                     │
│                                                          │
│  MCP Layer (src/mcp/)                                    │
│    Browser tools: navigate, click, type, scroll, ...     │
│                                                          │
│  Agent Layer (src/agent/)                                │
│    LLM-driven agent loop with tool calling               │
│                                                          │
│  Semantic Layer (src/semantic/)                           │
│    Accessibility tree analysis, content extraction        │
│    Element matching, page classification                 │
│                                                          │
│  Browser Layer (src/browser/)                            │
│    Puppeteer (headless + headful dual instances)          │
│    Session & tab management, cookie store                │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

## MCP Tools

The following tools are available to LLM agents via MCP:

| Tool | Description |
|------|-------------|
| `navigate` | Open a URL, with timeout degradation for slow pages |
| `get_page_info` | Get interactive elements with semantic IDs |
| `get_page_content` | Extract page text with attention scores |
| `find_element` | Fuzzy search for elements by name or type |
| `click` | Click an element by semantic ID |
| `type_text` | Type text into an input, optionally press Enter |
| `press_key` | Press keyboard keys (Enter, Escape, Tab, etc.) |
| `scroll` | Scroll the page up or down |
| `go_back` | Navigate back |
| `wait` | Wait for page loading |

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/v1/sessions` | Create a browser session |
| `GET` | `/v1/sessions/:id` | Get session details |
| `DELETE` | `/v1/sessions/:id` | Close a session |
| `POST` | `/v1/sessions/:id/navigate` | Navigate to a URL |
| `GET` | `/v1/sessions/:id/semantic` | Get semantic elements |
| `POST` | `/v1/sessions/:id/action` | Execute browser action |
| `GET` | `/v1/sessions/:id/screenshot` | Take a screenshot |
| `GET` | `/v1/sessions/:id/content` | Extract page content |
| `POST` | `/v1/sessions/:id/tabs` | Create a new tab |
| `GET` | `/v1/sessions/:id/tabs` | List all tabs |
| `POST` | `/v1/agent/run` | Start an agent task |
| `GET` | `/v1/agent/:id/events` | SSE stream of agent events |
| `GET` | `/mcp/sse` | SSE MCP connection |
| `POST` | `/mcp/message` | SSE MCP message endpoint |

## Headless / Headful Mode

By default the browser runs in headless mode. To use headful mode (e.g. for manual login):

- **CLI**: `HEADLESS=false ai-browser`
- **Agent UI**: Uncheck "Headless Mode" in Settings
- **API**: `POST /v1/sessions` with `{ "options": { "headless": false } }`

Cookies are shared across sessions via the built-in cookie store, so you can log in with a headful session and then create a headless session that reuses the login state.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `3000` |
| `HOST` | HTTP server host | `127.0.0.1` |
| `HEADLESS` | Set to `false` for headful mode | `true` |
| `CHROME_PATH` | Custom Chrome/Chromium path | auto-detect |
| `PROXY_SERVER` | HTTP proxy for the browser | — |
| `LLM_API_KEY` | LLM API key (for built-in agent) | — |
| `LLM_BASE_URL` | LLM API base URL | — |
| `LLM_MODEL` | LLM model name | — |

## Development

```bash
git clone https://github.com/chenpu17/ai-browser.git
cd ai-browser
npm install
npm run dev      # Dev server with hot reload
npm run build    # Build TypeScript
npm test         # Run tests
npm run test:run # Run tests once
```

## License

MIT
