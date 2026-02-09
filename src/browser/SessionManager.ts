import { randomUUID } from 'node:crypto';
import { Page } from 'puppeteer';
import { BrowserManager, BrowserOptions } from './BrowserManager.js';
import { CookieStore } from './CookieStore.js';
import { PageEventTracker, PageEventTrackerOptions } from './PageEventTracker.js';

export interface Tab {
  id: string;
  page: Page;
  url: string;
  events?: PageEventTracker;
}

export interface Session {
  id: string;
  tabs: Map<string, Tab>;
  activeTabId: string;
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
  headless: boolean;
  browserOptions: BrowserOptions;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private browserManager: BrowserManager;
  private tabCounter = 0;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private cookieSyncTimer: NodeJS.Timeout | null = null;
  private cookieStore: CookieStore | null = null;
  private cleanupRunning = false;
  private syncRunning = false;
  private idleCloseTimerHeadless: NodeJS.Timeout | null = null;
  private idleCloseTimerHeadful: NodeJS.Timeout | null = null;
  private readonly CLEANUP_INTERVAL = 60000;
  private readonly COOKIE_SYNC_INTERVAL = 30000;
  private readonly IDLE_CLOSE_DELAY = 120000; // 2 minutes
  private readonly MAX_TABS_PER_SESSION = 20;
  private pageEventTrackerOptions: PageEventTrackerOptions = {};

  constructor(browserManager: BrowserManager) {
    this.browserManager = browserManager;
    this.startCleanupTimer();
  }

  /** 设置 PageEventTracker 选项（用于测试等场景） */
  setPageEventTrackerOptions(options: PageEventTrackerOptions): void {
    this.pageEventTrackerOptions = options;
  }

  /** 设置 CookieStore，启动 headful 会话的定期 cookie 同步 */
  setCookieStore(store: CookieStore): void {
    this.cookieStore = store;
    this.startCookieSyncTimer();
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredSessions();
    }, this.CLEANUP_INTERVAL);
  }

  private async cleanupExpiredSessions(): Promise<void> {
    if (this.cleanupRunning) return;
    this.cleanupRunning = true;
    try {
      const now = Date.now();
      const expiredIds: string[] = [];
      for (const [id, session] of this.sessions) {
        if (session.expiresAt < now) {
          expiredIds.push(id);
        }
      }
      // 过期关闭前保存 cookie（尤其是 headful 会话可能有用户手动登录的状态）
      if (this.cookieStore && expiredIds.length > 0) {
        for (const id of expiredIds) {
          await this.saveSessionCookies(this.sessions.get(id));
        }
      }
      await Promise.all(expiredIds.map((id) => this.close(id)));
    } finally {
      this.cleanupRunning = false;
    }
    this.scheduleIdleBrowserClose();
  }

  stopTimers(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.cookieSyncTimer) {
      clearInterval(this.cookieSyncTimer);
      this.cookieSyncTimer = null;
    }
    if (this.idleCloseTimerHeadless) {
      clearTimeout(this.idleCloseTimerHeadless);
      this.idleCloseTimerHeadless = null;
    }
    if (this.idleCloseTimerHeadful) {
      clearTimeout(this.idleCloseTimerHeadful);
      this.idleCloseTimerHeadful = null;
    }
  }

  /** 检查是否还有对应类型的 session，若无则延迟关闭浏览器实例 */
  private scheduleIdleBrowserClose(): void {
    const hasHeadless = [...this.sessions.values()].some(s => s.headless);
    const hasHeadful = [...this.sessions.values()].some(s => !s.headless);

    // Schedule headless close if no headless sessions remain
    if (!hasHeadless && this.browserManager.isHeadlessLaunched()) {
      if (!this.idleCloseTimerHeadless) {
        this.idleCloseTimerHeadless = setTimeout(async () => {
          this.idleCloseTimerHeadless = null;
          try {
            const stillNoHeadless = ![...this.sessions.values()].some(s => s.headless);
            if (stillNoHeadless) {
              await this.browserManager.closeHeadless();
            }
          } catch {
            // Browser may already be closed, ignore
          }
        }, this.IDLE_CLOSE_DELAY);
      }
    } else if (hasHeadless && this.idleCloseTimerHeadless) {
      clearTimeout(this.idleCloseTimerHeadless);
      this.idleCloseTimerHeadless = null;
    }

    // Schedule headful close if no headful sessions remain
    if (!hasHeadful && this.browserManager.isHeadfulLaunched()) {
      if (!this.idleCloseTimerHeadful) {
        this.idleCloseTimerHeadful = setTimeout(async () => {
          this.idleCloseTimerHeadful = null;
          try {
            const stillNoHeadful = ![...this.sessions.values()].some(s => !s.headless);
            if (stillNoHeadful) {
              await this.browserManager.closeHeadful();
            }
          } catch {
            // Browser may already be closed, ignore
          }
        }, this.IDLE_CLOSE_DELAY);
      }
    } else if (hasHeadful && this.idleCloseTimerHeadful) {
      clearTimeout(this.idleCloseTimerHeadful);
      this.idleCloseTimerHeadful = null;
    }
  }

  private startCookieSyncTimer(): void {
    if (this.cookieSyncTimer) return;
    this.cookieSyncTimer = setInterval(() => {
      this.syncHeadfulCookies();
    }, this.COOKIE_SYNC_INTERVAL);
  }

  /** 通过 CDP 获取页面所有 cookie（包括跨域 SSO cookie）并保存到 CookieStore */
  private async saveSessionCookies(session: Session | undefined): Promise<void> {
    if (!this.cookieStore || !session) return;
    for (const tab of session.tabs.values()) {
      try {
        const url = tab.page.url();
        if (!url || url === 'about:blank') continue;
        const client = await tab.page.createCDPSession();
        try {
          const { cookies } = await client.send('Network.getAllCookies');
          this.cookieStore.save(url, cookies as any[]);
        } finally {
          await client.detach().catch(() => {});
        }
      } catch {
        // page may be closed or crashed, ignore
      }
    }
  }

  /** 从所有 headful 会话的页面中采集 cookie 保存到 CookieStore */
  async syncHeadfulCookies(): Promise<void> {
    if (!this.cookieStore || this.syncRunning) return;
    this.syncRunning = true;
    try {
      const headfulSessions = [...this.sessions.values()].filter(s => !s.headless);
      for (const session of headfulSessions) {
        await this.saveSessionCookies(session);
      }
    } finally {
      this.syncRunning = false;
    }
  }

  /** 保存指定会话 + 所有 headful 会话的 cookie（用于 close_session 前） */
  async saveAllCookies(sessionId: string): Promise<void> {
    if (!this.cookieStore) return;
    // 保存当前会话的 cookie
    await this.saveSessionCookies(this.sessions.get(sessionId));
    // 同步所有 headful 会话的 cookie
    await this.syncHeadfulCookies();
  }

  /** 为 headful 页面注册自动 cookie 保存（检测到 Set-Cookie 响应头时触发，防抖 2 秒） */
  private async setupAutoCookieSync(page: Page): Promise<void> {
    if (!this.cookieStore) return;
    const store = this.cookieStore;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const saveCookies = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        try {
          const url = page.url();
          if (!url || url === 'about:blank') return;
          const c = await page.createCDPSession();
          try {
            const { cookies } = await c.send('Network.getAllCookies');
            store.save(url, cookies as any[]);
          } finally {
            await c.detach().catch(() => {});
          }
        } catch {
          // page closed, ignore
        }
      }, 2000);
    };

    // 用持久 CDP session 监听 Set-Cookie 响应头
    try {
      const client = await page.createCDPSession();
      await client.send('Network.enable');
      client.on('Network.responseReceivedExtraInfo', (params: any) => {
        const headers = params.headers || {};
        // 检查是否有 set-cookie 头（不区分大小写）
        const hasSetCookie = Object.keys(headers).some(
          k => k.toLowerCase() === 'set-cookie'
        );
        if (hasSetCookie) saveCookies();
      });
      // 页面导航也触发保存
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) saveCookies();
      });
    } catch {
      // fallback: 如果 CDP 失败，仅用 framenavigated
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) saveCookies();
      });
    }
  }

  /** 为 Tab 创建并绑定 PageEventTracker */
  private async setupPageListeners(tab: Tab): Promise<void> {
    const tracker = new PageEventTracker(this.pageEventTrackerOptions);
    await tracker.attach(tab.page);
    tab.events = tracker;
  }

  async create(options: BrowserOptions = {}): Promise<Session> {
    const page = await this.browserManager.newPage(options);
    const now = Date.now();
    // headful 会话默认 24 小时超时，headless 默认 1 小时
    const isHeadful = options.headless === false;
    const defaultTimeout = isHeadful ? 86400 : 3600;
    const timeout = (options.timeout ?? defaultTimeout) * 1000;

    const tabId = `tab_${++this.tabCounter}`;
    const tab: Tab = { id: tabId, page, url: '' };
    const tabs = new Map<string, Tab>();
    tabs.set(tabId, tab);

    const session: Session = {
      id: `sess_${randomUUID()}`,
      tabs,
      activeTabId: tabId,
      createdAt: now,
      lastActivityAt: now,
      expiresAt: now + timeout,
      headless: options.headless !== false,
      browserOptions: options,
    };

    this.sessions.set(session.id, session);
    // Setup page event tracking
    await this.setupPageListeners(tab);
    // headful 会话注册自动 cookie 同步（检测到 Set-Cookie 时自动保存）
    if (isHeadful) {
      await this.setupAutoCookieSync(page);
    }
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

    const page = await this.browserManager.newPage(session.browserOptions);
    if (!session.headless) {
      await this.setupAutoCookieSync(page);
    }
    const tabId = `tab_${++this.tabCounter}`;
    const tab: Tab = { id: tabId, page, url: '' };
    await this.setupPageListeners(tab);
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

  /** 将 popup 页面注册为新 Tab */
  async registerPopupAsTab(sessionId: string, popupPage: Page): Promise<Tab | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.tabs.size >= this.MAX_TABS_PER_SESSION) return null;

    const tabId = `tab_${++this.tabCounter}`;
    const tab: Tab = { id: tabId, page: popupPage, url: popupPage.url() };
    await this.setupPageListeners(tab);
    if (!session.headless) {
      await this.setupAutoCookieSync(popupPage);
    }
    session.tabs.set(tabId, tab);
    return tab;
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
      await tab.events?.detach();
      await tab.page.close();
    } catch {
      // ignore close errors
    }
    session.tabs.delete(tabId);

    // 如果关闭的是最后一个Tab，关闭整个Session
    if (session.tabs.size === 0) {
      this.sessions.delete(sessionId);
      this.scheduleIdleBrowserClose();
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

    // 关闭所有Tab（先 detach events，再关闭页面）
    const closePromises = Array.from(session.tabs.values()).map(async tab => {
      try { await tab.events?.detach(); } catch {}
      try { await tab.page.close(); } catch {}
    });
    await Promise.allSettled(closePromises);
    this.sessions.delete(id);
    this.scheduleIdleBrowserClose();
    return true;
  }

  updateActivity(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      const now = Date.now();
      session.lastActivityAt = now;
      // headful 会话有活跃操作时延长过期时间，避免用户手动操作期间被清理
      if (!session.headless) {
        const remaining = session.expiresAt - now;
        const minRemaining = 3600 * 1000; // 至少保留 1 小时
        if (remaining < minRemaining) {
          session.expiresAt = now + minRemaining;
        }
      }
    }
  }

  async closeAll(): Promise<void> {
    this.stopTimers();
    // 关闭前保存所有会话的 cookie
    if (this.cookieStore) {
      for (const session of this.sessions.values()) {
        await this.saveSessionCookies(session);
      }
    }
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.close(id)));
  }
}
