// Library exports — programmatic API
export { createBrowserMcpServer, BrowserMcpServerOptions } from './mcp/browser-mcp-server.js';
export { BrowserManager, BrowserOptions, SessionManager, Session, CookieStore } from './browser/index.js';
export { BrowsingAgent } from './agent/agent-loop.js';
export {
  ContentExtractor,
  ContentSection,
  ExtractedContent,
  ElementCollector,
  PageAnalyzer,
  PageAnalysis,
  RegionDetector,
  ElementMatcher,
  MatchCandidate,
  IframeHandler,
  FrameInfo,
} from './semantic/index.js';
export { registerRoutes, ApiError, ErrorCode } from './api/index.js';
