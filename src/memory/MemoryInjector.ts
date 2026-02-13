import type { KnowledgeCard, SitePattern } from './types.js';
import { MemoryCapturer } from './MemoryCapturer.js';

const DEFAULT_MAX_CHARS = 2000;

/**
 * Compute substring-based relevance score between an intent value and a hint.
 * CJK-compatible: uses sliding window substring matching instead of word splitting.
 * Returns the length of the longest matching substring (≥2 chars), or 0.
 */
export function relevanceScore(intentValue: string, hint: string): number {
  if (hint.length < 2) return 0;
  const lowerIntent = intentValue.toLowerCase();
  const lowerHint = hint.toLowerCase();
  // From longest to shortest, find the first match
  for (let len = lowerHint.length; len >= 2; len--) {
    for (let i = 0; i <= lowerHint.length - len; i++) {
      if (lowerIntent.includes(lowerHint.slice(i, i + len))) {
        return len;
      }
    }
  }
  return 0;
}

export class MemoryInjector {
  /**
   * Extract target domain from task text.
   * Looks for URLs or well-known domain names.
   */
  static extractDomain(task: string): string | null {
    // Try to find a URL in the task
    const urlMatch = task.match(/https?:\/\/[^\s,，。、）)]+/);
    if (urlMatch) {
      const domain = MemoryCapturer.extractDomain(urlMatch[0]);
      if (domain) return domain;
    }

    // Try to find domain-like patterns (e.g., bilibili.com, jd.com)
    const domainMatch = task.match(/\b([a-zA-Z0-9][-a-zA-Z0-9]*\.(?:com|cn|org|net|io|co|tv|cc|me)(?:\.[a-z]{2})?)\b/);
    if (domainMatch) {
      return domainMatch[1].replace(/^www\./, '');
    }

    // Try well-known site names (Chinese context)
    const siteMap: Record<string, string> = {
      'B站': 'bilibili.com',
      'b站': 'bilibili.com',
      '哔哩哔哩': 'bilibili.com',
      'bilibili': 'bilibili.com',
      '京东': 'jd.com',
      '淘宝': 'taobao.com',
      '天猫': 'tmall.com',
      '微博': 'weibo.com',
      '知乎': 'zhihu.com',
      '百度': 'baidu.com',
      '豆瓣': 'douban.com',
      '36氪': '36kr.com',
      '新浪': 'sina.com.cn',
      '网易': '163.com',
      '腾讯': 'qq.com',
      '抖音': 'douyin.com',
      '小红书': 'xiaohongshu.com',
      'github': 'github.com',
      'Google': 'google.com',
      'google': 'google.com',
      'bing': 'bing.com',
      'Bing': 'bing.com',
      '必应': 'bing.com',
    };

    const lowerTask = task.toLowerCase();
    for (const [name, domain] of Object.entries(siteMap)) {
      if (lowerTask.includes(name.toLowerCase())) return domain;
    }

    return null;
  }

  /**
   * Build a compact prompt fragment from a knowledge card.
   * Sorted by effective confidence, hard-limited to maxChars.
   * When taskHint is provided, task_intent patterns are sorted by substring relevance.
   */
  static buildContext(card: KnowledgeCard, maxChars = DEFAULT_MAX_CHARS, taskHint?: string): string {
    const now = Date.now();
    const lines: string[] = [];

    // Header
    const siteTag = card.siteType === 'spa' ? ' [SPA]' : card.siteType === 'ssr' ? ' [SSR]' : '';
    lines.push(`## 站点记忆: ${card.domain}${siteTag}`);

    if (card.requiresLogin) {
      lines.push('- 需要登录: 是');
    }

    // Task intents first (most valuable context for the agent), cap at 3
    let intents = card.patterns.filter(p => p.type === 'task_intent');
    if (taskHint && intents.length > 0) {
      // Sort by substring relevance (CJK-compatible), then by recency
      intents.sort((a, b) => {
        const scoreA = relevanceScore(a.value, taskHint);
        const scoreB = relevanceScore(b.value, taskHint);
        if (scoreA !== scoreB) return scoreB - scoreA;
        return b.lastUsedAt - a.lastUsedAt;
      });
    } else {
      intents.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    }
    intents = intents.slice(0, 3);

    if (intents.length > 0) {
      lines.push('');
      lines.push('### 已知任务经验（请优先按此步骤操作）');
      for (const intent of intents) {
        // Structured prefix to reduce prompt injection surface
        const truncated = intent.value.slice(0, 800);
        const line = `- 任务: ${truncated}`;
        lines.push(line);
      }
      lines.push('');
    }

    let currentLength = lines.reduce((sum, l) => sum + l.length + 1, 0);

    // If intents already consumed most of the budget, warn and limit
    if (currentLength > maxChars - 200) {
      lines.push('⚠️ 以上为历史经验，如页面结构已变化请忽略并重新探索。');
      return lines.join('\n').slice(0, maxChars);
    }

    // Sort patterns by effective confidence
    const sorted = [...card.patterns].sort((a, b) => {
      const confA = a.confidence * Math.pow(0.95, (now - a.lastUsedAt) / 86400000);
      const confB = b.confidence * Math.pow(0.95, (now - b.lastUsedAt) / 86400000);
      return confB - confA;
    });

    // Global types are always included; selector/navigation_path are filtered by taskHint
    const globalTypes = new Set(['login_required', 'spa_hint', 'page_structure']);

    for (const p of sorted) {
      if (p.type === 'task_intent') continue; // already rendered above

      // When taskHint is provided, skip non-global patterns that don't match
      if (taskHint && !globalTypes.has(p.type)) {
        const matchText = `${p.description} ${p.value}`;
        if (relevanceScore(matchText, taskHint) === 0) continue;
      }

      const effConf = p.confidence * Math.pow(0.95, (now - p.lastUsedAt) / 86400000);
      const confStr = effConf.toFixed(2);
      const useStr = p.useCount > 1 ? `, 用过${p.useCount}次` : '';
      let line: string;

      switch (p.type) {
        case 'selector':
          line = `- 选择器 \`${p.value}\` → ${p.description}，可用 execute_javascript querySelector 操作 (置信度:${confStr}${useStr})`;
          break;
        case 'navigation_path':
          line = `- 路径: ${p.value} (置信度:${confStr}${useStr})`;
          break;
        case 'login_required':
          line = `- 需要登录 (置信度:${confStr})`;
          break;
        case 'spa_hint':
          line = `- SPA提示: ${p.description} (置信度:${confStr}${useStr})`;
          break;
        case 'page_structure':
          line = `- 结构: ${p.description} (置信度:${confStr}${useStr})`;
          break;
        default:
          line = `- ${p.description} (置信度:${confStr}${useStr})`;
      }

      // Check char budget before adding
      if (currentLength + line.length + 1 > maxChars - 80) break; // reserve space for footer
      lines.push(line);
      currentLength += line.length + 1;
    }

    lines.push('');
    lines.push('⚠️ 以上为历史经验，如页面结构已变化请忽略并重新探索。');

    return lines.join('\n');
  }

  /** Count patterns by type for the tool response */
  static countPatternTypes(patterns: SitePattern[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const p of patterns) {
      counts[p.type] = (counts[p.type] || 0) + 1;
    }
    return counts;
  }
}
