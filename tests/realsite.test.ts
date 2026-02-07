import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BrowserManager } from '../src/browser/BrowserManager.js';
import { SessionManager } from '../src/browser/SessionManager.js';
import { ElementCollector } from '../src/semantic/ElementCollector.js';
import { PageAnalyzer } from '../src/semantic/PageAnalyzer.js';
import { ContentExtractor } from '../src/semantic/ContentExtractor.js';
import { RegionDetector } from '../src/semantic/RegionDetector.js';

const TEST_SITES = [
  { url: 'https://www.google.com', name: 'Google', expectedType: 'search' },
  { url: 'https://www.baidu.com', name: 'Baidu', expectedType: 'search' },
  { url: 'https://www.bing.com', name: 'Bing', expectedType: 'search' },
  { url: 'https://www.github.com', name: 'GitHub', expectedType: 'unknown' },
  { url: 'https://www.wikipedia.org', name: 'Wikipedia', expectedType: 'unknown' },
  { url: 'https://www.example.com', name: 'Example', expectedType: 'unknown' },
  { url: 'https://news.ycombinator.com', name: 'HackerNews', expectedType: 'list' },
  { url: 'https://www.reddit.com', name: 'Reddit', expectedType: 'list' },
  { url: 'https://www.stackoverflow.com', name: 'StackOverflow', expectedType: 'unknown' },
  { url: 'https://www.amazon.com', name: 'Amazon', expectedType: 'unknown' },
  { url: 'http://ali.chenpu.fun:13478', name: 'AliTest', expectedType: 'unknown' },
];

describe('Real Website Tests', () => {
  let browserManager: BrowserManager;
  let sessionManager: SessionManager;
  let elementCollector: ElementCollector;
  let pageAnalyzer: PageAnalyzer;
  let contentExtractor: ContentExtractor;
  let regionDetector: RegionDetector;

  beforeAll(async () => {
    browserManager = new BrowserManager();
    await browserManager.launch({ headless: true });
    sessionManager = new SessionManager(browserManager);
    elementCollector = new ElementCollector();
    pageAnalyzer = new PageAnalyzer();
    contentExtractor = new ContentExtractor();
    regionDetector = new RegionDetector();
  }, 30000);

  afterAll(async () => {
    await sessionManager.closeAll();
    await browserManager.close();
  });

  describe('Basic connectivity', () => {
    it('should connect to example.com', async () => {
      const session = await sessionManager.create();
      const tab = sessionManager.getActiveTab(session.id);
      expect(tab).toBeDefined();
      await tab!.page.goto('https://example.com', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      const title = await tab!.page.title();
      expect(title).toBeTruthy();
      await sessionManager.close(session.id);
    }, 60000);
  });
});
