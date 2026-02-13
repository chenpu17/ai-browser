# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI-friendly browser automation service providing semantic web page analysis via HTTP API and MCP protocol. Helps AI agents browse and interact with web pages using accessibility-tree-based semantic element IDs.

## Build & Development Commands

```bash
npm install                # Install dependencies
npm run build              # TypeScript compilation (tsc)
npm run dev                # Dev server with watch (tsx watch, port 3000)
npm run start              # Production server (node dist/)
npm test                   # Run tests in watch mode (vitest)
npm run test:run           # Run tests once
npm run test:contract      # Run contract tests (login-keep-session, task-tools)
npm run agent              # Run standalone agent (tsx src/agent/index.ts)
npm run lint               # ESLint
```

Single test file: `npx vitest run tests/<filename>.test.ts`

## Architecture

8-layer stack, each layer only depends on layers below it:

- **CLI Layer** (`src/cli/`): Two entry points — `server.ts` (HTTP server, bin: `ai-browser`) and `mcp-stdio.ts` (stdio MCP, bin: `ai-browser-mcp`)
- **API Layer** (`src/api/`): Fastify HTTP server with REST routes (`routes.ts`, 45KB) and SSE MCP transport (`mcp-sse.ts`)
- **MCP Layer** (`src/mcp/`): ~39 tools registered in `browser-mcp-server.ts` via `server.tool()` (28 browser primitives + 3 composite + 7 task-runtime; `recall_site_memory` conditionally registered when `knowledgeStore` is provided). AI-optimized output formatting in `ai-markdown.ts`. Task runtime tools in `task-tools.ts`
- **Agent Layer** (`src/agent/`): LLM-driven autonomous browsing. `BrowsingAgent` in `agent-loop.ts` runs think→tool_call→result loop. `TaskAgent` in `task-agent.ts` runs deterministic (non-LLM) task templates
- **Memory Layer** (`src/memory/`): Site memory system — `KnowledgeCardStore` persists selectors/navigation paths per domain, `SessionRecorder` captures interactions, `MemoryInjector` injects recalled context into agent
- **Task Layer** (`src/task/`): Deterministic task templates (`templates/` dir) with `RunManager`, artifact storage, cancellation support
- **Semantic Layer** (`src/semantic/`): Chrome Accessibility Tree (CDP) analysis. `ElementCollector` extracts elements, each gets a semantic ID (`{prefix}_{label}_{backendNodeId}`), injected into DOM as `data-semantic-id`
- **Browser Layer** (`src/browser/`): Puppeteer-extra with stealth plugin. `BrowserManager` manages headless/headful instances. `SessionManager` handles sessions (max 20 tabs each). `CookieStore` persists cookies across domains via CDP

### Bootstrap Flow (HTTP server)

1. Launch `BrowserManager` → 2. Create `SessionManager` → 3. Create `CookieStore` + `KnowledgeCardStore` → 4. Create MCP server via `createBrowserMcpServer()` → 5. Register Fastify routes + SSE MCP → 6. Listen

### Data Flow — MCP Tool Results

Two parallel consumer paths for MCP tool responses:

1. **LLM path**: `agent-loop.ts` → `content-budget.ts` (`formatToolResult`) → conversation messages
2. **Web UI path**: `agent-loop.ts` → SSE `tool_result` event → `public/index.html` (`formatMdResult`)

Display priority: `aiMarkdown` > `aiSummary` > manual formatting > raw JSON.

When MCP output format changes, update both `src/agent/content-budget.ts` and `public/index.html`.

## Key Concepts

### Semantic Element IDs
- Elements identified by IDs like `btn_Submit_123`, `link_News_456`
- Generated as `{prefix}_{label}_{backendNodeId}` in `semantic/ElementCollector.ts` (role mapped to prefix, e.g. `button`→`btn`, `textbox`→`input`)
- Injected into DOM via `data-semantic-id` attribute
- All interaction tools (click, type, hover, etc.) use these IDs

### Trust Levels
- `TrustLevel` (`'local'` | `'remote'`) controls security per entry point
- `local` (stdio MCP + Agent): allows `file:` URLs, no private IP blocking
- `remote` (SSE MCP): blocks private IPs, DNS rebinding check, disables `upload_file` and `execute_javascript`

### Sessions and Tabs
- Sessions auto-expire and auto-cleanup; max 20 tabs per session
- All tools accept optional `sessionId`; omitting it auto-creates/reuses a default session
- SSE connections track created sessions and clean up headless sessions on disconnect

### AI Markdown Enrichment
- `enrichWithAiMarkdown(toolName, data)` in `src/mcp/ai-markdown.ts` adds AI-friendly fields to tool responses
- Fields: `aiSchemaVersion`, `aiDetailLevel`, `aiSummary`, `aiMarkdown`, `aiHints`, `nextActions`, `deltaSummary`
- Detail level controlled by `AI_MARKDOWN_DETAIL_LEVEL` env var (brief/normal/full)

### Structured Error Codes
- Error responses include `errorCode`: `ELEMENT_NOT_FOUND`, `NAVIGATION_TIMEOUT`, `SESSION_NOT_FOUND`, `PAGE_CRASHED`, `INVALID_PARAMETER`, `EXECUTION_ERROR`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `HOST` | `127.0.0.1` | HTTP server host |
| `HEADLESS` | `true` | Set `false` for headful browser |
| `CHROME_PATH` | (auto) | Custom Chrome executable path |
| `PROXY_SERVER` | — | Proxy server URL |
| `LLM_API_KEY` | — | OpenAI-compatible API key for agent |
| `LLM_BASE_URL` | — | OpenAI-compatible base URL |
| `LLM_MODEL` | — | Model name for agent |
| `AI_MARKDOWN_DETAIL_LEVEL` | `normal` | AI output detail: brief/normal/full |
| `AI_MARKDOWN_ADAPTIVE_POLICY` | — | Adaptive detail policy |

## Testing

- Framework: Vitest with `globals: true`, Node environment
- Tests in `tests/` directory, fixtures in `tests/fixtures/`
- Uses `InMemoryTransport` for MCP testing
- Key test files: `mcp.test.ts` (comprehensive MCP tool tests), `agent-loop.test.ts`, `browser.test.ts`, `integration.test.ts`

## Code Style

- TypeScript strict mode, ES2022 target, NodeNext module resolution
- ESM (`"type": "module"` in package.json)
- async/await for all async operations
- Use `trustLevel` parameter (not raw `urlValidation`) when creating MCP servers
- Use `validateUrlAsync` for navigation in remote mode (DNS rebinding protection)
- Cookie store is shared across all sessions — do not filter by domain (preserves cross-domain SSO)
- MCP tool results use `textResult()` / `errorResult()` helpers with `ErrorCode`
