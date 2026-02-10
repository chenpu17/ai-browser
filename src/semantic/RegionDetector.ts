import { Page } from 'puppeteer-core';
import { Region, Rect } from '../types/index.js';

export class RegionDetector {
  async detect(page: Page): Promise<Region[]> {
    const regions: Region[] = [];

    const landmarks = await this.detectLandmarks(page);
    regions.push(...landmarks);

    if (regions.length === 0) {
      regions.push(await this.createMainRegion(page));
    }

    return regions;
  }

  private async detectLandmarks(page: Page): Promise<Region[]> {
    return page.evaluate(() => {
      const regions: Array<{
        name: string;
        role: string;
        bounds: { x: number; y: number; width: number; height: number };
      }> = [];

      const landmarkSelectors = [
        { selector: 'header, [role="banner"]', name: 'header', role: 'banner' },
        { selector: 'nav, [role="navigation"]', name: 'navigation', role: 'navigation' },
        { selector: 'main, [role="main"]', name: 'main', role: 'main' },
        { selector: 'aside, [role="complementary"]', name: 'sidebar', role: 'complementary' },
        { selector: 'footer, [role="contentinfo"]', name: 'footer', role: 'contentinfo' },
        { selector: '[role="search"]', name: 'search', role: 'search' },
      ];

      for (const { selector, name, role } of landmarkSelectors) {
        const el = document.querySelector(selector);
        if (el) {
          const rect = el.getBoundingClientRect();
          regions.push({
            name,
            role,
            bounds: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            },
          });
        }
      }

      return regions;
    });
  }

  private async createMainRegion(page: Page): Promise<Region> {
    const viewport = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    }));

    return {
      name: 'main',
      role: 'main',
      bounds: { x: 0, y: 0, ...viewport },
    };
  }
}
