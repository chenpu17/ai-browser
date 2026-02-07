import { Page, Frame } from 'puppeteer';
import { Rect } from '../types/index.js';

export interface FrameInfo {
  id: string;
  url: string;
  bounds: Rect;
  isVisible: boolean;
  isCrossOrigin: boolean;
}

export class IframeHandler {
  async detectFrames(page: Page): Promise<FrameInfo[]> {
    const frames: FrameInfo[] = [];
    const mainFrame = page.mainFrame();
    const childFrames = mainFrame.childFrames();

    for (let i = 0; i < childFrames.length; i++) {
      const frame = childFrames[i];
      const info = await this.getFrameInfo(page, frame, i);
      if (info) frames.push(info);
    }

    return frames;
  }

  private async getFrameInfo(
    page: Page,
    frame: Frame,
    index: number
  ): Promise<FrameInfo | null> {
    try {
      const url = frame.url();
      const pageUrl = page.url();
      const isCrossOrigin = this.isCrossOrigin(pageUrl, url);

      // 使用frame的元素句柄获取bounds，避免索引不匹配
      const bounds = await this.getFrameBoundsByElement(frame);

      return {
        id: `frame_${index}`,
        url,
        bounds,
        isVisible: bounds.width > 0 && bounds.height > 0,
        isCrossOrigin,
      };
    } catch {
      return null;
    }
  }

  private isCrossOrigin(pageUrl: string, frameUrl: string): boolean {
    try {
      if (!frameUrl || frameUrl === 'about:blank') return false;
      const pageOrigin = new URL(pageUrl).origin;
      const frameOrigin = new URL(frameUrl).origin;
      return pageOrigin !== frameOrigin;
    } catch {
      return true;
    }
  }

  private async getFrameBoundsByElement(frame: Frame): Promise<Rect> {
    try {
      const frameUrl = frame.url();
      const parentPage = frame.page();

      // 通过frame URL在父页面中查找对应的iframe元素
      const bounds = await parentPage.evaluate((url) => {
        const iframes = Array.from(document.querySelectorAll('iframe'));
        for (const iframe of iframes) {
          if (iframe.src === url || (iframe.contentWindow as any)?.location?.href === url) {
            const rect = iframe.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          }
        }
        return { x: 0, y: 0, width: 0, height: 0 };
      }, frameUrl);

      return bounds;
    } catch {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
  }

  getFrame(page: Page, frameId: string): Frame | null {
    const index = parseInt(frameId.replace('frame_', ''), 10);
    const frames = page.mainFrame().childFrames();
    return frames[index] || null;
  }
}
