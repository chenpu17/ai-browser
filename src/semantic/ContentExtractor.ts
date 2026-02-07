import { Page } from 'puppeteer';

export interface ContentSection {
  tag: string;        // 语义标签：h1, h2, p, li, blockquote 等
  text: string;       // 文本内容
  attention: number;  // 0-1 注意力分值
}

export interface ExtractedContent {
  title: string;
  sections: ContentSection[];
  links: Array<{ text: string; url: string }>;
  images: Array<{ alt: string; src: string }>;
  metadata: Record<string, string>;
}

export class ContentExtractor {
  async extract(page: Page): Promise<ExtractedContent> {
    return page.evaluate(() => {
      const title = document.title;

      // === 注意力分值计算 ===
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      const viewportArea = viewportW * viewportH;
      const viewportCenterX = viewportW / 2;
      const viewportCenterY = viewportH / 2;
      const maxDistance = Math.sqrt(viewportCenterX ** 2 + viewportCenterY ** 2);

      // 语义标签固定分值
      const semanticScores: Record<string, number> = {
        h1: 1.0, h2: 0.85, h3: 0.7, h4: 0.6, h5: 0.55, h6: 0.5,
        blockquote: 0.6, p: 0.5, li: 0.4, td: 0.3, th: 0.35,
        figcaption: 0.35, pre: 0.45, dt: 0.4, dd: 0.35,
      };

      // 块级内容节点选择器
      const blockSelector = Object.keys(semanticScores).join(', ');

      // 不可见元素过滤选择器
      const hiddenSelector =
        'script, style, noscript, svg, iframe, ' +
        '[style*="display:none"], [style*="display: none"], ' +
        '[hidden], [aria-hidden="true"], .hidden';

      // 收集所有块级内容节点
      const nodes = Array.from(document.querySelectorAll(blockSelector));

      // 第一遍：收集字号，找最大值（避免二次 getComputedStyle）
      const nodeStyles: Array<{ el: HTMLElement; style: CSSStyleDeclaration; fontSize: number }> = [];
      let maxFontSize = 16;
      for (const node of nodes) {
        const el = node as HTMLElement;
        if (el.closest(hiddenSelector)) continue;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
        const fontSize = parseFloat(style.fontSize);
        if (fontSize > maxFontSize) maxFontSize = fontSize;
        nodeStyles.push({ el, style, fontSize });
      }

      // 权重
      const W_POSITION = 0.35;
      const W_AREA = 0.25;
      const W_FONTSIZE = 0.15;
      const W_SEMANTIC = 0.25;

      // 用于嵌套去重：记录已收录的文本
      const seenTexts = new Set<string>();
      const sections: Array<{ tag: string; text: string; attention: number }> = [];

      for (const { el, style, fontSize } of nodeStyles) {
        // 提取文本
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length < 2) continue;

        // 跳过与已收录内容完全相同的文本（处理嵌套元素如 blockquote > p）
        if (seenTexts.has(text)) continue;
        seenTexts.add(text);

        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        const tag = el.tagName.toLowerCase();

        // 1. 位置分值：元素中心到视口中心的距离
        const elCenterX = rect.left + rect.width / 2;
        const elCenterY = rect.top + rect.height / 2;
        const dist = Math.sqrt((elCenterX - viewportCenterX) ** 2 + (elCenterY - viewportCenterY) ** 2);
        let positionScore = 1 - Math.min(dist / maxDistance, 1);
        // 首屏加分
        if (rect.top >= 0 && rect.bottom <= viewportH) {
          positionScore = Math.min(positionScore + 0.2, 1);
        }

        // 2. 面积分值（sqrt 归一化，避免文本块分值趋近于零）
        const area = rect.width * rect.height;
        const areaScore = Math.min(Math.sqrt(area / viewportArea), 1);

        // 3. 字号分值
        const fontSizeScore = fontSize / maxFontSize;

        // 4. 语义分值
        const semanticScore = semanticScores[tag] ?? 0.3;

        // 综合注意力分值
        const attention = W_POSITION * positionScore
          + W_AREA * areaScore
          + W_FONTSIZE * fontSizeScore
          + W_SEMANTIC * semanticScore;

        sections.push({
          tag,
          text: text.slice(0, 500),
          attention: Math.round(attention * 1000) / 1000,
        });
      }

      // 按注意力降序排列，截取前50个
      sections.sort((a, b) => b.attention - a.attention);
      const topSections = sections.slice(0, 50);

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

      return { title, sections: topSections, links, images, metadata };
    });
  }
}
