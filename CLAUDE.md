# AI Browser - MCP Service for AI-Friendly Web Browsing

## Project Overview

This is an AI-friendly browser automation service that provides semantic web page analysis via HTTP API. It's designed to help AI agents browse and interact with web pages efficiently.

## Architecture

- **CLI Layer** (`src/cli/`): Entry points — HTTP server (`ai-browser`) and stdio MCP (`ai-browser-mcp`)
- **API Layer** (`src/api/`): Fastify HTTP server with REST API and SSE MCP endpoint
- **MCP Layer** (`src/mcp/`): Browser tools exposed via MCP protocol (39 tools: 28 browser primitives + 3 composite tools + 1 memory tool + 7 task-runtime tools — navigate, click, type, screenshot, fill_form, click_and_wait, navigate_and_extract, recall_site_memory, template run/query, artifact retrieval, etc.)
- **Agent Layer** (`src/agent/`): LLM-driven autonomous browsing agent with tool calling, conversation memory management, progress estimation, error recovery, loop detection, and token tracking
- **Semantic Layer** (`src/semantic/`): Accessibility tree analysis, content extraction, element matching
- **Browser Layer** (`src/browser/`): Puppeteer-based browser management with multi-tab sessions, cookie store

## Key Concepts

### Sessions and Tabs
- Each session contains multiple tabs (like browser windows)
- Sessions have expiration and auto-cleanup
- Max 20 tabs per session
- All tools accept optional `sessionId`; omitting it auto-creates/reuses a default session

### Structured Error Codes
- Error responses include `errorCode` field: `ELEMENT_NOT_FOUND`, `NAVIGATION_TIMEOUT`, `SESSION_NOT_FOUND`, `PAGE_CRASHED`, `INVALID_PARAMETER`, `EXECUTION_ERROR`

### Semantic Elements
- Elements are identified by semantic IDs (e.g., `btn_Submit_123`, `link_News_456`)
- IDs are injected into DOM via `data-semantic-id` attribute
- Elements can be interacted with using these IDs

### Trust Levels
- `TrustLevel` (`'local'` | `'remote'`) controls security policies per entry point
- `local`: stdio MCP + Agent API — allows `file:` URLs, no private IP blocking
- `remote`: SSE MCP — blocks private IPs, DNS rebinding check, disables `upload_file` and `execute_javascript`
- SSE connections track created sessions and clean up headless sessions on disconnect

## Development

```bash
npm install      # Install dependencies
npm run build    # Build TypeScript
npm run dev      # Start dev server
npm test         # Run tests
```

## API Endpoints

- `POST /v1/sessions` - Create session
- `GET /v1/sessions/:id/semantic` - Get semantic elements
- `POST /v1/sessions/:id/action` - Execute action (click, type, scroll, hover, select)
- `GET /v1/sessions/:id/screenshot` - Take screenshot
- `GET /v1/sessions/:id/content` - Extract page content
- `POST /v1/sessions/:id/tabs` - Create new tab
- `GET /v1/sessions/:id/tabs` - List tabs
- `POST /v1/sessions/:id/tabs/batch-content` - Get content from multiple tabs

## MCP Tools (39)

### Browser Primitives (28)

| Tool | Description |
|------|-------------|
| `create_session` | Create a browser session |
| `close_session` | Close a browser session |
| `navigate` | Open a URL (returns statusCode, detects dialogs) |
| `get_page_info` | Get interactive elements (supports maxElements, visibleOnly, includes stability/dialog info) |
| `get_page_content` | Extract page text (supports maxLength) |
| `find_element` | Fuzzy search for elements |
| `click` | Click an element by semantic ID (captures popup windows as new tabs) |
| `type_text` | Type text into an input |
| `press_key` | Press keyboard keys, supports modifier combos (Ctrl+A, Shift+Tab) |
| `scroll` | Scroll the page |
| `go_back` | Navigate back |
| `wait` | Wait for condition (time, selector, networkidle, element_hidden) |
| `screenshot` | Take a page screenshot (supports fullPage, element, format/quality) |
| `hover` | Hover over an element |
| `select_option` | Select a dropdown option |
| `set_value` | Set element value directly (for rich text editors, contenteditable) |
| `execute_javascript` | Execute JavaScript on the page |
| `create_tab` | Create a new tab |
| `list_tabs` | List all tabs |
| `switch_tab` | Switch active tab |
| `close_tab` | Close a tab |
| `handle_dialog` | Handle page dialogs (accept/dismiss alert, confirm, prompt) |
| `get_dialog_info` | Get pending dialog and dialog history |
| `wait_for_stable` | Wait for DOM stability (no mutations + no pending network) |
| `get_network_logs` | Get network request logs (filter by xhr, failed, slow, urlPattern) |
| `get_console_logs` | Get console logs (filter by level) |
| `upload_file` | Upload a file to a file input element |
| `get_downloads` | Get downloaded files list |

### Composite Tools (3)

| Tool | Description |
|------|-------------|
| `fill_form` | Fill multiple form fields and optionally submit in one call |
| `click_and_wait` | Click an element then wait for stable/navigation/selector |
| `navigate_and_extract` | Navigate to URL and extract content/elements in one call |

### Memory Tools (1)

| Tool | Description |
|------|-------------|
| `recall_site_memory` | Query site memory for a domain before navigating (returns known selectors, navigation paths, task intents) |

### Task Runtime Tools (7)

| Tool | Description |
|------|-------------|
| `list_task_templates` | List available deterministic task templates |
| `run_task_template` | Run a template in sync/async/auto mode |
| `get_task_run` | Query run status, progress, result, and artifact refs |
| `list_task_runs` | List runs with pagination and filters |
| `cancel_task_run` | Cancel an active run |
| `get_artifact` | Read run artifacts by chunks |
| `get_runtime_profile` | Get runtime limits and profile info |

## Data Flow & Consumer Contract

MCP tool responses flow through two parallel consumer paths:

1. **LLM path**: `agent-loop.ts` → `content-budget.ts` (`formatToolResult`) → conversation messages
2. **Web UI path**: `agent-loop.ts` → SSE `tool_result` event (`summary: rawText`) → `public/index.html`

Both paths receive the full MCP JSON (including `aiMarkdown`, `aiSummary`, `aiHints`, etc.). When MCP output format changes (e.g., new AI-optimized fields), **all downstream consumers must be updated**:

- `src/agent/content-budget.ts` — LLM consumption
- `public/index.html` (`formatMdResult`) — Web UI rendering

Priority for displaying tool results: `aiMarkdown` > `aiSummary` > manual formatting > raw JSON.

## Code Style

- TypeScript with strict mode
- Use async/await for all async operations
- Handle errors gracefully with try/catch
- Validate URLs before navigation (protocol whitelist, optional private IP blocking)
- Use `trustLevel` instead of raw `urlValidation` options when creating MCP servers
- Gate dangerous tools (`upload_file`, `execute_javascript`) behind `isRemote` check
- Use `validateUrlAsync` for navigation in remote mode (DNS rebinding protection)
- Cookie store is shared across all sessions — do not filter by domain (preserves cross-domain SSO)
