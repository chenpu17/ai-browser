import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BrowserManager } from '../src/browser/BrowserManager.js';

describe('BrowserManager', () => {
  let browserManager: BrowserManager;

  beforeAll(async () => {
    browserManager = new BrowserManager();
    await browserManager.launch({ headless: true });
  });

  afterAll(async () => {
    await browserManager.close();
  });

  it('should create a new page', async () => {
    const page = await browserManager.newPage();
    expect(page).toBeDefined();
    await page.close();
  });

  it('should navigate to a URL', async () => {
    const page = await browserManager.newPage();
    await page.goto('about:blank');
    expect(page.url()).toBe('about:blank');
    await page.close();
  });
});
