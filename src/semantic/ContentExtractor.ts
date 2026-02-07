import { Page } from 'puppeteer';

export interface ExtractedContent {
  title: string;
  text: string;
  links: Array<{ text: string; url: string }>;
  images: Array<{ alt: string; src: string }>;
  metadata: Record<string, string>;
}

export class ContentExtractor {
  async extract(page: Page): Promise<ExtractedContent> {
    return page.evaluate(() => {
      const title = document.title;

      // 提取正文
      let text = '';
      const main = document.querySelector('main, article, [role="main"], #content, .content');
      const root = main || document.body;
      const clone = root.cloneNode(true) as HTMLElement;
      // 移除不可见和无关元素
      clone.querySelectorAll(
        'script, style, noscript, svg, iframe, nav, header, footer, ' +
        '[style*="display:none"], [style*="display: none"], ' +
        '[hidden], [aria-hidden="true"], .hidden'
      ).forEach((el) => el.remove());
      // 提取文本并压缩空白
      text = (clone.textContent || '')
        .replace(/\t/g, ' ')
        .replace(/ {2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, 10000);

      // 提取链接
      const links = Array.from(document.querySelectorAll('a[href]'))
        .slice(0, 50)
        .map((a) => ({
          text: a.textContent?.trim() || '',
          url: (a as HTMLAnchorElement).href,
        }))
        .filter((l) => l.text && l.url);

      // 提取图片
      const images = Array.from(document.querySelectorAll('img[src]'))
        .slice(0, 20)
        .map((img) => ({
          alt: (img as HTMLImageElement).alt || '',
          src: (img as HTMLImageElement).src,
        }));

      // 提取元数据
      const metadata: Record<string, string> = {};
      document.querySelectorAll('meta').forEach((meta) => {
        const name = meta.getAttribute('name') || meta.getAttribute('property');
        const content = meta.getAttribute('content');
        if (name && content) metadata[name] = content;
      });

      return { title, text, links, images, metadata };
    });
  }
}
