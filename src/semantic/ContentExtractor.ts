import { Page } from 'puppeteer-core';

export interface ContentSection {
  tag: string;        // 语义标签：h1, h2, p, li, blockquote 等
  text: string;       // 文本内容
  attention: number;  // 0-1 注意力分值
  heading?: string;   // 最近的标题上下文
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

      const getHeadingText = (el: HTMLElement): string => {
        if (/^h[1-6]$/i.test(el.tagName)) return (el.textContent || '').trim().slice(0, 120);
        let current: HTMLElement | null = el;
        while (current) {
          let sibling: Element | null = current.previousElementSibling;
          while (sibling) {
            if (/^H[1-6]$/.test(sibling.tagName)) {
              return (sibling.textContent || '').trim().slice(0, 120);
            }
            sibling = sibling.previousElementSibling;
          }
          current = current.parentElement;
        }
        return '';
      };

      // 第一遍：收集字号，找最大值（避免二次 getComputedStyle）
      const nodeStyles: Array<{ el: HTMLElement; style: CSSStyleDeclaration; fontSize: number; order: number; inMain: boolean; heading: string }> = [];
      let maxFontSize = 16;
      let order = 0;
      for (const node of nodes) {
        const el = node as HTMLElement;
        if (el.closest(hiddenSelector)) continue;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
        const fontSize = parseFloat(style.fontSize);
        if (fontSize > maxFontSize) maxFontSize = fontSize;
        nodeStyles.push({
          el,
          style,
          fontSize,
          order: order++,
          inMain: Boolean(el.closest('main, article, [role="main"], [role="article"]')),
          heading: getHeadingText(el),
        });
      }

      // 权重
      const W_POSITION = 0.22;
      const W_AREA = 0.2;
      const W_FONTSIZE = 0.12;
      const W_SEMANTIC = 0.2;
      const W_CONTEXT = 0.18;
      const W_LENGTH = 0.08;
      // The weights intentionally sum to 1.0 so the final attention score remains normalized.
      // Below-the-fold content remains important on long articles and list pages,
      // so we soften the penalty until roughly three viewport heights away.
      const OFFSCREEN_DISTANCE_MULTIPLIER = 3;

      // 用于嵌套去重：记录已收录的文本
      const seenTexts = new Set<string>();
      const sections: Array<{ tag: string; text: string; attention: number; heading?: string; order: number }> = [];

      for (const { el, fontSize, order, inMain, heading } of nodeStyles) {
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
        const verticalDistance = Math.abs(elCenterY - viewportCenterY);
        let positionScore = 1 - Math.min(dist / maxDistance, 1);
        const offscreenPenalty = Math.min(verticalDistance / (viewportH * OFFSCREEN_DISTANCE_MULTIPLIER), 1);
        positionScore = Math.max(positionScore, 1 - offscreenPenalty);
        if (rect.top >= 0 && rect.bottom <= viewportH) positionScore = Math.min(positionScore + 0.15, 1);

        // 2. 面积分值（sqrt 归一化，避免文本块分值趋近于零）
        const area = rect.width * rect.height;
        const areaScore = Math.min(Math.sqrt(area / viewportArea), 1);

        // 3. 字号分值
        const fontSizeScore = fontSize / maxFontSize;

        // 4. 语义分值
        const semanticScore = semanticScores[tag] ?? 0.3;
        const contextScore = inMain ? 1 : 0.45;
        const lengthScore = Math.min(text.length / 240, 1);

        // 综合注意力分值
        const attention = W_POSITION * positionScore
          + W_AREA * areaScore
          + W_FONTSIZE * fontSizeScore
          + W_SEMANTIC * semanticScore
          + W_CONTEXT * contextScore
          + W_LENGTH * lengthScore;

        sections.push({
          tag,
          text: text.slice(0, 500),
          attention: Math.round(attention * 1000) / 1000,
          heading: heading || undefined,
          order,
        });
      }

      // 先按注意力筛选，再按文档顺序输出，提升长正文可读性
      sections.sort((a, b) => b.attention - a.attention || a.order - b.order);
      let topSections = sections.slice(0, 50).sort((a, b) => a.order - b.order);

      // Fallback: SPA 站点可能不使用语义标签，从 div/section/article/span 中提取文本
      if (topSections.length < 3) {
        const fallbackSelector = 'div, section, article, main, [role="article"], [role="main"]';
        const fallbackNodes = Array.from(document.querySelectorAll(fallbackSelector));
        const fallbackSections: Array<{ tag: string; text: string; attention: number; heading?: string; order: number }> = [];
        const fallbackSeen = new Set(seenTexts);
        let fallbackOrder = order;

        for (const node of fallbackNodes) {
          const el = node as HTMLElement;
          if (el.closest(hiddenSelector)) continue;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

          // Only consider leaf-ish containers with direct text content
          const directText = Array.from(el.childNodes)
            .filter(n => n.nodeType === Node.TEXT_NODE)
            .map(n => (n.textContent || '').trim())
            .join(' ')
            .trim();
          const fullText = (el.textContent || '').replace(/\s+/g, ' ').trim();
          // Use element if it has meaningful direct text, or is a leaf with short content
          const text = directText.length > 10 ? directText
            : (el.children.length === 0 && fullText.length > 10) ? fullText
            : (fullText.length > 20 && fullText.length < 2000 && el.querySelectorAll('div, section, article').length === 0) ? fullText
            : '';
          if (!text || text.length < 10) continue;
          if (fallbackSeen.has(text)) continue;
          fallbackSeen.add(text);

          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;

          const area = rect.width * rect.height;
          const areaScore = Math.min(Math.sqrt(area / viewportArea), 1);
          const elCenterY = rect.top + rect.height / 2;
          const posScore = (elCenterY >= 0 && elCenterY <= viewportH) ? 0.6 : 0.3;

          fallbackSections.push({
            tag: el.tagName.toLowerCase(),
            text: text.slice(0, 500),
            attention: Math.round((posScore * 0.5 + areaScore * 0.5) * 1000) / 1000,
            heading: getHeadingText(el) || undefined,
            order: fallbackOrder++,
          });
        }

        fallbackSections.sort((a, b) => b.attention - a.attention || a.order - b.order);
        topSections = [...topSections, ...fallbackSections.slice(0, 50 - topSections.length)]
          .sort((a, b) => a.order - b.order);
      }

      // Last resort: if still no content, use innerText split into chunks
      if (topSections.length === 0) {
        const bodyText = (document.body.innerText || '').trim();
        if (bodyText.length > 10) {
          const lines = bodyText.split('\n').filter(l => l.trim().length > 0);
          let chunk = '';
          for (const line of lines) {
            if (chunk.length + line.length > 400) {
              if (chunk.trim()) {
                topSections.push({ tag: 'div', text: chunk.trim(), attention: 0.3, order: topSections.length });
              }
              chunk = line;
              if (topSections.length >= 50) break;
            } else {
              chunk += (chunk ? '\n' : '') + line;
            }
          }
          if (chunk.trim() && topSections.length < 50) {
            topSections.push({ tag: 'div', text: chunk.trim(), attention: 0.3, order: topSections.length });
          }
        }
      }

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

      return {
        title,
        sections: topSections.map(({ order: _order, ...section }) => section),
        links,
        images,
        metadata,
      };
    });
  }
}
