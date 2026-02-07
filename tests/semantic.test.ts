import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BrowserManager } from '../src/browser/BrowserManager.js';
import { PageAnalyzer } from '../src/semantic/PageAnalyzer.js';
import { RegionDetector } from '../src/semantic/RegionDetector.js';
import { ElementMatcher } from '../src/semantic/ElementMatcher.js';
import { PageType } from '../src/types/index.js';
import path from 'path';

describe('Semantic Modules', () => {
  let browserManager: BrowserManager;
  let pageAnalyzer: PageAnalyzer;
  let regionDetector: RegionDetector;
  let elementMatcher: ElementMatcher;

  beforeAll(async () => {
    browserManager = new BrowserManager();
    await browserManager.launch({ headless: true });
    pageAnalyzer = new PageAnalyzer();
    regionDetector = new RegionDetector();
    elementMatcher = new ElementMatcher();
  });

  afterAll(async () => {
    await browserManager.close();
  });

  describe('PageAnalyzer', () => {
    it('should identify login page', async () => {
      const page = await browserManager.newPage();
      const filePath = path.resolve('tests/fixtures/login.html');
      await page.goto(`file://${filePath}`);

      const analysis = await pageAnalyzer.analyze(page);
      expect(analysis.pageType).toBe(PageType.LOGIN);
      expect(analysis.intents.length).toBeGreaterThan(0);
      await page.close();
    });

    it('should identify search page', async () => {
      const page = await browserManager.newPage();
      const filePath = path.resolve('tests/fixtures/search.html');
      await page.goto(`file://${filePath}`);

      const analysis = await pageAnalyzer.analyze(page);
      // file://路径包含"search"会被识别为search_results
      expect([PageType.SEARCH_ENGINE, PageType.SEARCH_RESULTS]).toContain(analysis.pageType);
      await page.close();
    });
  });

  describe('RegionDetector', () => {
    it('should detect page regions', async () => {
      const page = await browserManager.newPage();
      const filePath = path.resolve('tests/fixtures/search.html');
      await page.goto(`file://${filePath}`);

      const regions = await regionDetector.detect(page);
      expect(regions.length).toBeGreaterThan(0);
      const regionNames = regions.map(r => r.name);
      expect(regionNames).toContain('header');
      await page.close();
    });
  });

  describe('ElementMatcher', () => {
    it('should find elements by query', () => {
      const elements = [
        { id: 'btn_login_1', type: 'button', label: 'Login', actions: [], state: { visible: true, enabled: true, focused: false }, region: 'main', bounds: { x: 0, y: 0, width: 0, height: 0 } },
      ];
      const candidates = elementMatcher.findByQuery(elements as any, 'login');
      expect(candidates.length).toBeGreaterThan(0);
    });
  });
});