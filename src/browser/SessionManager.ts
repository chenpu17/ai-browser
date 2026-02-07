import { Page } from 'puppeteer';
import { BrowserManager, BrowserOptions } from './BrowserManager.js';

export interface Tab {
  id: string;
  page: Page;
  url: string;
}

export interface Session {
  id: string;
  tabs: Map<string, Tab>;
  activeTabId: string;
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private browserManager: BrowserManager;
  private sessionCounter = 0;
  private tabCounter = 0;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly CLEANUP_INTERVAL = 60000;
  private readonly MAX_TABS_PER_SESSION = 20;

  constructor(browserManager: BrowserManager) {
    this.browserManager = browserManager;
    this.startCleanupTimer();
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredSessions();
    }, this.CLEANUP_INTERVAL);
  }

  private async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();
    const expiredIds: string[] = [];
    for (const [id, session] of this.sessions) {
      if (session.expiresAt < now) {
        expiredIds.push(id);
      }
    }
    await Promise.all(expiredIds.map((id) => this.close(id)));
  }

  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  async create(options: BrowserOptions = {}): Promise<Session> {
    const page = await this.browserManager.newPage(options);
    const now = Date.now();
    const timeout = (options.timeout ?? 3600) * 1000;

    const tabId = `tab_${++this.tabCounter}`;
    const tab: Tab = { id: tabId, page, url: '' };
    const tabs = new Map<string, Tab>();
    tabs.set(tabId, tab);

    const session: Session = {
      id: `sess_${++this.sessionCounter}`,
      tabs,
      activeTabId: tabId,
      createdAt: now,
      lastActivityAt: now,
      expiresAt: now + timeout,
    };

    this.sessions.set(session.id, session);
    return session;
  }

  // 兼容旧API：获取当前活动Tab的Page
  get page(): never {
    throw new Error('Use getActiveTab() instead');
  }

  getActiveTab(sessionId: string): Tab | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return session.tabs.get(session.activeTabId);
  }

  async createTab(sessionId: string): Promise<Tab | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    // 检查Tab数量限制
    if (session.tabs.size >= this.MAX_TABS_PER_SESSION) {
      throw new Error(`Maximum tabs per session (${this.MAX_TABS_PER_SESSION}) exceeded`);
    }

    const page = await this.browserManager.newPage();
    const tabId = `tab_${++this.tabCounter}`;
    const tab: Tab = { id: tabId, page, url: '' };
    session.tabs.set(tabId, tab);
    return tab;
  }

  getTab(sessionId: string, tabId: string): Tab | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return session.tabs.get(tabId);
  }

  listTabs(sessionId: string): Tab[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return Array.from(session.tabs.values());
  }

  switchTab(sessionId: string, tabId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.tabs.has(tabId)) return false;
    session.activeTabId = tabId;
    return true;
  }

  async closeTab(sessionId: string, tabId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const tab = session.tabs.get(tabId);
    if (!tab) return false;

    try {
      await tab.page.close();
    } catch {
      // ignore close errors
    }
    session.tabs.delete(tabId);

    // 如果关闭的是最后一个Tab，关闭整个Session
    if (session.tabs.size === 0) {
      this.sessions.delete(sessionId);
      return true;
    }

    // 如果关闭的是活动Tab，切换到另一个
    if (session.activeTabId === tabId) {
      session.activeTabId = session.tabs.keys().next().value!;
    }
    return true;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  async close(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;

    // 关闭所有Tab（使用allSettled防止单个失败影响其他）
    const closePromises = Array.from(session.tabs.values()).map(tab =>
      tab.page.close().catch(() => {/* ignore close errors */})
    );
    await Promise.allSettled(closePromises);
    this.sessions.delete(id);
    return true;
  }

  updateActivity(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.lastActivityAt = Date.now();
    }
  }

  async closeAll(): Promise<void> {
    this.stopCleanupTimer();
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.close(id)));
  }
}
