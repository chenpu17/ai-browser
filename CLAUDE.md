# AI Browser - MCP Service for AI-Friendly Web Browsing

## Project Overview

This is an AI-friendly browser automation service that provides semantic web page analysis via HTTP API. It's designed to help AI agents browse and interact with web pages efficiently.

## Architecture

- **Browser Layer** (`src/browser/`): Puppeteer-based browser management with multi-tab session support
- **Semantic Layer** (`src/semantic/`): Extracts structured semantic information from web pages
- **API Layer** (`src/api/`): Fastify HTTP server exposing RESTful endpoints

## Key Concepts

### Sessions and Tabs
- Each session contains multiple tabs (like browser windows)
- Sessions have expiration and auto-cleanup
- Max 20 tabs per session

### Semantic Elements
- Elements are identified by semantic IDs (e.g., `btn_Submit_123`, `link_News_456`)
- IDs are injected into DOM via `data-semantic-id` attribute
- Elements can be interacted with using these IDs

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
- `POST /v1/sessions/:id/action` - Execute action (click, type, scroll)
- `POST /v1/sessions/:id/tabs` - Create new tab
- `POST /v1/sessions/:id/tabs/batch-content` - Get content from multiple tabs

## Code Style

- TypeScript with strict mode
- Use async/await for all async operations
- Handle errors gracefully with try/catch
- Validate URLs before navigation (http/https/file only)
