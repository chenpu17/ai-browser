import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BrowserManager } from '../src/browser/BrowserManager.js';
import { SessionManager } from '../src/browser/SessionManager.js';

describe('SessionManager', () => {
  let browserManager: BrowserManager;
  let sessionManager: SessionManager;

  beforeAll(async () => {
    browserManager = new BrowserManager();
    await browserManager.launch({ headless: true });
    sessionManager = new SessionManager(browserManager);
  });

  afterAll(async () => {
    await sessionManager.closeAll();
    await browserManager.close();
  });

  it('should create a session', async () => {
    const session = await sessionManager.create();
    expect(session.id).toMatch(/^sess_[0-9a-f-]{36}$/);
    expect(session.tabs.size).toBe(1);
    expect(session.activeTabId).toBeDefined();
    const activeTab = sessionManager.getActiveTab(session.id);
    expect(activeTab).toBeDefined();
    expect(activeTab?.page).toBeDefined();
    expect(session.createdAt).toBeGreaterThan(0);
  });

  it('should get a session by id', async () => {
    const session = await sessionManager.create();
    const retrieved = sessionManager.get(session.id);
    expect(retrieved).toBe(session);
  });

  it('should return undefined for non-existent session', () => {
    const session = sessionManager.get('non_existent');
    expect(session).toBeUndefined();
  });

  it('should close a session', async () => {
    const session = await sessionManager.create();
    const closed = await sessionManager.close(session.id);
    expect(closed).toBe(true);
    expect(sessionManager.get(session.id)).toBeUndefined();
  });

  it('should update activity timestamp', async () => {
    const session = await sessionManager.create();
    const originalTime = session.lastActivityAt;
    await new Promise((r) => setTimeout(r, 10));
    sessionManager.updateActivity(session.id);
    expect(session.lastActivityAt).toBeGreaterThan(originalTime);
  });
});
