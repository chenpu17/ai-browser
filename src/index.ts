// Library exports — programmatic API
export { createBrowserMcpServer } from './mcp/browser-mcp-server.js';
export type { BrowserMcpServerOptions } from './mcp/browser-mcp-server.js';
export { BrowserManager, SessionManager, CookieStore } from './browser/index.js';
export type { BrowserOptions, Session } from './browser/index.js';
export { BrowsingAgent } from './agent/agent-loop.js';
export { TaskAgent } from './agent/task-agent.js';
export type { TaskSpec, PlanStep, PlannerRule, PlannerSource, VerifyResult, TaskAgentResult } from './agent/task-agent.js';
export {
  ContentExtractor,
  ElementCollector,
  PageAnalyzer,
  RegionDetector,
  ElementMatcher,
  IframeHandler,
} from './semantic/index.js';
export type {
  ContentSection,
  ExtractedContent,
  PageAnalysis,
  MatchCandidate,
  FrameInfo,
} from './semantic/index.js';
export { registerRoutes, ApiError, ErrorCode } from './api/index.js';
