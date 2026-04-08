import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BrowserManager } from '../src/browser/BrowserManager.js';
import { ContentExtractor } from '../src/semantic/ContentExtractor.js';
import path from 'path';

describe('ContentExtractor', () => {
  let browserManager: BrowserManager;
  let contentExtractor: ContentExtractor;

  beforeAll(async () => {
    browserManager = new BrowserManager();
    await browserManager.launch({ headless: true });
    contentExtractor = new ContentExtractor();
  });

  afterAll(async () => {
    await browserManager.close();
  });

  it('should extract page content', async () => {
    const page = await browserManager.newPage();
    const filePath = path.resolve('tests/fixtures/article.html');
    await page.goto(`file://${filePath}`);

    const content = await contentExtractor.extract(page);
    expect(content.title).toBe('Test Article');
    expect(Array.isArray(content.sections)).toBe(true);
    const allText = content.sections.map((s: any) => s.text).join(' ');
    expect(allText).toContain('Article Title');
    await page.close();
  });

  it('keeps long-page sections in reading order with offscreen content', async () => {
    const page = await browserManager.newPage();
    const filePath = path.resolve('tests/fixtures/long-page.html');
    await page.goto(`file://${filePath}`);

    const content = await contentExtractor.extract(page);
    const joined = content.sections.map((s: any) => s.text).join(' ');
    expect(joined).toContain('Section 1');
    expect(joined).toContain('Section 5');
    expect(content.sections.findIndex((s: any) => s.text.includes('Section 1')))
      .toBeLessThan(content.sections.findIndex((s: any) => s.text.includes('Section 5')));
    await page.close();
  });
});
