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

Task-oriented pages:
- `http://localhost:3000/tasks.html` — submit TaskAgent tasks
- `http://localhost:3000/task-result.html?taskId=...` — inspect task status/result/event stream

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

Start the HTTP server:

```bash
ai-browser --port 3000
```

SSE endpoint:
- `http://127.0.0.1:3000/mcp/sse`

For custom clients, use MCP SDK `SSEClientTransport` (it handles the message endpoint internally):

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const client = new Client({ name: 'my-client', version: '0.1.0' });
const transport = new SSEClientTransport(new URL('http://127.0.0.1:3000/mcp/sse'));

await client.connect(transport);

const { tools } = await client.listTools();
console.log('tool count:', tools.length);

const created = await client.callTool({ name: 'create_session', arguments: {} });
console.log(created);
```

Notes:
- This server currently exposes legacy HTTP+SSE MCP transport (`/mcp/sse` + `/mcp/message`).
- The message endpoint is `POST /mcp/message?sessionId=...` and is primarily for transport internals.

### 4.1 MCP AI Consumer Guide

For AI-oriented consumption rules (`nextActions`, `hasMore/nextCursor`, `topIssues`, detail levels), see:
- `docs/18-mcp-ai-consumer-guide.md`
- `docs/19-mcp-ai-readability-roadmap.md` (P0-P2 roadmap and execution checklist)
- benchmark command: `npm run baseline:v1` (includes `aiFieldCoverageRate` / `invalidToolCallRate`)

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

The server currently exposes **38 MCP tools**:
- **28 browser primitive tools** (navigation, interaction, tabs, logs, uploads, etc.)
- **3 composite tools** (multi-step operations in one call)
- **7 task-runtime tools** (template execution, run tracking, artifacts)

Most browser tools accept an optional `sessionId` — omitting it auto-creates/reuses a default session.

AI-oriented tool responses now include additive helper fields on key tools:
- `aiSchemaVersion`: schema version for AI helper payload
- `aiDetailLevel`: applied detail level (`brief` / `normal` / `full`)
- `aiSummary`: short status sentence for fast decision-making
- `aiMarkdown`: compact, sectioned markdown with high-signal details
- `aiHints`: suggested next actions (text)
- `nextActions`: structured next-step suggestions (`tool`, `args`, `reason`)
- `deltaSummary`: polling-oriented change summary (`key`, `changes`)
- `schemaRepairGuidance`: repair-oriented hints for schema verification failures

List-like responses are also normalized with:
- `hasMore` + `nextCursor` for continuation semantics
- `topIssues` on log-oriented tools (network/console) for quick fault triage

These fields are additive and backward-compatible; existing JSON fields are unchanged.

You can control verbosity via environment variable `AI_MARKDOWN_DETAIL_LEVEL=brief|normal|full` (default: `normal`).

Optional adaptive policy (prototype): `AI_MARKDOWN_ADAPTIVE_POLICY=1`
- For polling-heavy tools, detail can auto-shift to `brief`
- On terminal failure states, detail can auto-escalate to `full`

### Session Management

| Tool | Description |
|------|-------------|
| `create_session` | Create a new browser session |
| `close_session` | Close a browser session (`force=true` closes headful sessions) |

### Navigation & Page Info

| Tool | Description |
|------|-------------|
| `navigate` | Open a URL, returns `statusCode`, with timeout degradation for slow pages, detects pending dialogs |
| `get_page_info` | Get interactive elements with semantic IDs (supports `maxElements`, `visibleOnly`; masks sensitive field values; includes stability and dialog info) |
| `get_page_content` | Extract page text with attention scores (supports `maxLength` truncation) |
| `find_element` | Fuzzy search for elements by name or type |
| `screenshot` | Take a page screenshot (supports `fullPage`, `element_id`, `format`, `quality`) |
| `execute_javascript` | Execute JavaScript on the page (**local mode only**; 5s timeout, 4000-char result truncation) |

### Element Interaction

| Tool | Description |
|------|-------------|
| `click` | Click an element by semantic ID (captures popup windows as new tabs) |
| `type_text` | Type text into an input, optionally press Enter |
| `hover` | Hover over an element to trigger tooltips/dropdowns |
| `select_option` | Select a dropdown option by value |
| `set_value` | Set element value directly (for rich text editors, contenteditable) |
| `press_key` | Press keyboard keys (Enter, Escape, Tab, etc.), supports modifier combos (`modifiers: ['Control']`) |
| `scroll` | Scroll the page up or down |
| `go_back` | Navigate back |
| `wait` | Wait by condition: `time`, `selector`, `networkidle`, or `element_hidden` |

### Tab Management

| Tool | Description |
|------|-------------|
| `create_tab` | Create a new tab (auto-switches to it, optional URL) |
| `list_tabs` | List all tabs in the session |
| `switch_tab` | Switch to a specific tab |
| `close_tab` | Close a specific tab |

### Dialog Handling

| Tool | Description |
|------|-------------|
| `handle_dialog` | Handle page dialogs — accept or dismiss alert, confirm, prompt |
| `get_dialog_info` | Get pending dialog info and dialog history |

### Page Monitoring

| Tool | Description |
|------|-------------|
| `wait_for_stable` | Wait for DOM stability (no mutations + no pending network requests) |
| `get_network_logs` | Get network request logs (filter by `xhr`, `failed`, `slow`, `urlPattern`) |
| `get_console_logs` | Get console logs (filter by level, default: error + warn) |

### File Handling

| Tool | Description |
|------|-------------|
| `upload_file` | Upload a file to a file input element (**local mode only**) |
| `get_downloads` | Get downloaded files list |

### Composite Tools (Multi-Step Operations)

| Tool | Description |
|------|-------------|
| `fill_form` | Fill multiple form fields and optionally submit in one call (`fields: [{ element_id, value }]`, optional `submit`) |
| `click_and_wait` | Click an element then wait for stable/navigation/selector (`element_id` + `waitFor: 'stable'\|'navigation'\|'selector'`) |
| `navigate_and_extract` | Navigate to URL and extract content in one call (`url` + `extract: 'content'\|'elements'\|'both'`) |

### Task Runtime (Non-LLM Templates)

| Tool | Description |
|------|-------------|
| `list_task_templates` | List available deterministic task templates |
| `run_task_template` | Run a template in `sync` / `async` / `auto` mode |
| `get_task_run` | Query run status, progress, result, and artifact refs |
| `list_task_runs` | List runs with pagination and filters (`status`, `templateId`) |
| `cancel_task_run` | Cancel an active run |
| `get_artifact` | Read run artifacts by chunks (`offset`, `limit`) |
| `get_runtime_profile` | Get runtime limits and profile info |

### Structured Error Codes

Error responses include an `errorCode` field for programmatic handling:

| Code | Meaning |
|------|---------|
| `ELEMENT_NOT_FOUND` | Element does not exist, includes `hint` to refresh page info |
| `NAVIGATION_TIMEOUT` | Page load timed out, may retry |
| `SESSION_NOT_FOUND` | Session does not exist |
| `PAGE_CRASHED` | Page crashed or was closed |
| `INVALID_PARAMETER` | Invalid parameter value |
| `EXECUTION_ERROR` | JavaScript execution error |
| `TEMPLATE_NOT_FOUND` | Task template does not exist |
| `TRUST_LEVEL_NOT_ALLOWED` | Template not allowed in current trust level |
| `RUN_NOT_FOUND` | Run ID does not exist |
| `RUN_TIMEOUT` | Run exceeded timeout |
| `RUN_CANCELED` | Run canceled by client |
| `ARTIFACT_NOT_FOUND` | Artifact does not exist or expired |

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
| `POST` | `/v1/tasks` | Submit a TaskAgent task |
| `GET` | `/v1/tasks/:taskId` | Query task status and result |
| `GET` | `/v1/tasks/:taskId/events` | SSE stream of task events |
| `GET` | `/mcp/sse` | SSE MCP connection |
| `POST` | `/mcp/message` | SSE MCP message endpoint |


## Task API Quick Start

Submit a task:

```bash
curl -sX POST http://127.0.0.1:3000/v1/tasks \
  -H 'content-type: application/json' \
  -d '{
    "goal": "Batch extract page summaries",
    "inputs": { "urls": ["https://example.com"] },
    "constraints": { "maxDurationMs": 30000, "maxSteps": 20 },
    "budget": { "maxRetries": 1, "maxToolCalls": 120 }
  }'
```

Then poll status by `taskId` (`GET /v1/tasks/:taskId`) or subscribe to events (`GET /v1/tasks/:taskId/events`).

## Headless / Headful Mode

By default the browser runs in headless mode. To use headful mode (e.g. for manual login):

- **CLI**: `HEADLESS=false ai-browser`
- **Agent UI**: Uncheck "Headless Mode" in Settings
- **API**: `POST /v1/sessions` with `{ "options": { "headless": false } }`

Cookies are shared across sessions via the built-in cookie store, so you can log in with a headful session and then create a headless session that reuses the login state.

## Security

AI Browser uses a **trust level** system to control security policies across different entry points.

### Trust Levels

| Level | Entry Point | Description |
|-------|-------------|-------------|
| `local` | stdio MCP (`ai-browser-mcp`), Agent API, Task API (`/v1/tasks`) | Full access — allows `file:` URLs, no private IP blocking |
| `remote` | SSE MCP (`/mcp/sse`) | Restricted — blocks private/loopback IPs, DNS rebinding protection, disables `upload_file` and `execute_javascript` |

### SSE Endpoint Restrictions (remote mode)

- **Private IP blocking**: Navigation to `localhost`, `127.0.0.1`, `10.x.x.x`, `192.168.x.x`, and other RFC 1918 addresses is denied
- **DNS rebinding protection**: Hostnames that resolve to private IPs are blocked via async DNS lookup
- **Tool gating**: `upload_file` and `execute_javascript` are disabled to prevent local file access and arbitrary code execution
- **Session cleanup**: When an SSE connection disconnects, headless browser sessions created by that connection are automatically closed (headful sessions are preserved)

### Cookie Isolation

AI Browser is designed as a **single-user local tool**. All sessions share a single cookie store. For multi-user deployments, run separate instances per user.

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
npm run dev         # Dev server with hot reload
npm run build       # Build TypeScript
npm test            # Run tests
npm run test:run    # Run tests once
npm run baseline:v1 # Collect v1 baseline report
npm run benchmark:v1:expanded # Run expanded readability scenarios (P2 prototype)
npm run stress:v1   # Run 100-task stress report
```

## License

MIT
