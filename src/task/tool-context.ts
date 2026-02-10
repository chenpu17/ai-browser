import type { Page } from 'puppeteer-core';
import type { SessionManager, Tab } from '../browser/index.js';
import type { CookieStore } from '../browser/CookieStore.js';
import type { ValidateUrlOptions } from '../utils/url-validator.js';

export type TrustLevel = 'local' | 'remote';

/**
 * 工具执行上下文 — 由 MCP handler 或模板执行器构造。
 * 所有 toolAction 函数通过此接口获取依赖，不直接引用全局状态。
 */
export interface ToolContext {
  sessionManager: SessionManager;
  cookieStore?: CookieStore;
  urlOpts: ValidateUrlOptions;
  trustLevel: TrustLevel;

  /** 解析 sessionId（MCP: defaultSession 逻辑；模板: 直接返回绑定 sessionId） */
  resolveSession(sessionId?: string): Promise<string>;

  /** 获取指定 session 的活跃 tab */
  getActiveTab(sessionId: string): Tab;

  /** 获取指定 session 的指定 tab（并发 tab 场景） */
  getTab(sessionId: string, tabId: string): Tab | undefined;

  /** 注入 cookie 到页面（CDP） */
  injectCookies(page: Page): Promise<void>;

  /** 从页面保存 cookie（CDP） */
  saveCookies(page: Page): Promise<void>;
}
