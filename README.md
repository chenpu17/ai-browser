# AI Browser

An AI-driven browser automation service that enables LLM agents to browse and interact with web pages through semantic analysis and the MCP (Model Context Protocol).

[中文文档](./README_CN.md)

## Features

- **Semantic Web Analysis** — Extracts structured elements (buttons, links, inputs) from pages using the Chrome Accessibility Tree, assigning each a unique semantic ID for reliable interaction
- **LLM-Powered Agent** — An autonomous browsing agent driven by LLM tool calls, capable of navigating, searching, form-filling, and information extraction
- **MCP Protocol Integration** — Browser tools exposed via MCP, enabling standardized communication between the agent and browser
- **Real-time Monitoring** — Web UI with SSE-based live streaming of agent actions, tool calls, and results
- **Multi-Session Support** — Concurrent browser sessions with multi-tab management and automatic cleanup

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Web UI    │────▶│  Fastify API │────▶│  Browsing Agent  │
│  (SSE)      │     │  (REST)      │     │  (LLM Loop)      │
└─────────────┘     └──────────────┘     └────────┬─────────┘
                                                   │ MCP
                                          ┌────────▼─────────┐
                                          │  MCP Server       │
                                          │  (Browser Tools)  │
                                          └────────┬─────────┘
                                                   │
                                          ┌────────▼─────────┐
                                          │  Puppeteer        │
                                          │  + Semantic Layer  │
                                          └──────────────────┘
```

- **Browser Layer** (`src/browser/`) — Puppeteer-based browser management with multi-tab session support
- **Semantic Layer** (`src/semantic/`) — Accessibility tree analysis, content extraction, element matching, page classification
- **MCP Layer** (`src/mcp/`) — MCP server exposing browser tools (navigate, click, type, scroll, etc.)
- **Agent Layer** (`src/agent/`) — LLM-driven agent loop with tool calling, loop detection, and step management
- **API Layer** (`src/api/`) — Fastify HTTP server with REST endpoints and SSE event streaming

## Quick Start

### Prerequisites

- Node.js >= 18
- An OpenAI-compatible LLM API

### Installation

```bash
git clone https://github.com/chenpu17/ai-browser.git
cd ai-browser
npm install
```

### Configuration

Set environment variables:

```bash
export LLM_API_KEY="your-api-key"
export LLM_BASE_URL="https://api.openai.com/v1"  # or any OpenAI-compatible endpoint
export LLM_MODEL="gpt-4"                          # model name
export PROXY_SERVER="127.0.0.1:7897"               # optional, HTTP proxy for browser
```

### Run

```bash
# Development mode
npm run dev

# Or with environment variables inline
LLM_API_KEY=your-key npx tsx src/index.ts
```

Open `http://localhost:3000` for the web UI.

## MCP Tools

The agent has access to the following browser tools via MCP:

| Tool | Description |
|------|-------------|
| `navigate` | Open a URL, with timeout degradation for slow pages |
| `get_page_info` | Get interactive elements (buttons, links, inputs) with semantic IDs |
| `get_page_content` | Extract page text content (title, body, links, metadata) |
| `find_element` | Fuzzy search for elements by name, type, or Chinese/English aliases |
| `click` | Click an element by semantic ID |
| `type_text` | Type text into an input, with optional `submit=true` to press Enter |
| `press_key` | Press keyboard keys (Enter, Escape, Tab, etc.) |
| `scroll` | Scroll the page up or down |
| `wait` | Wait for page loading |
| `screenshot` | Take a page screenshot |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/v1/sessions` | Create a browser session |
| `GET` | `/v1/sessions/:id/semantic` | Get semantic elements |
| `POST` | `/v1/sessions/:id/action` | Execute browser action |
| `POST` | `/v1/agent/run` | Start an agent task |
| `GET` | `/v1/agent/:id/events` | SSE stream of agent events |

## Development

```bash
npm run build    # Build TypeScript
npm run dev      # Dev server with hot reload
npm test         # Run tests
npm run test:run # Run tests once
```

## Testing

The project includes a 20-scenario real-world browsing test suite:

```bash
node tests/run-scenarios.mjs
```

Scenarios cover: search engines, news sites, documentation, e-commerce, and more.

## License

MIT
