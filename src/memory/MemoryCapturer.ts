import type { ToolCallRecord } from '../agent/tool-usage-tracker.js';
import type { SitePattern, KnowledgeCard } from './types.js';

export class MemoryCapturer {
  /**
   * Extract reusable patterns from a successful agent run's tool history.
   */
  static extractPatterns(toolHistory: readonly ToolCallRecord[], finalUrl: string): SitePattern[] {
    const patterns: SitePattern[] = [];
    const now = Date.now();
    const seen = new Set<string>(); // dedup by value
    const consumedNavIndices = new Set<number>(); // skip already-consumed nav entries

    for (let i = 0; i < toolHistory.length; i++) {
      const call = toolHistory[i];
      if (!call.success) continue;

      // 1. execute_javascript with querySelector → selector pattern
      if (call.toolName === 'execute_javascript') {
        const script = call.args.script || call.args.code || '';
        const selectorMatches = script.match(/querySelector(?:All)?\(\s*['"`]([^'"`]+)['"`]\s*\)/g);
        if (selectorMatches) {
          for (const match of selectorMatches) {
            const inner = match.match(/['"`]([^'"`]+)['"`]/);
            if (inner && inner[1] && !seen.has(inner[1])) {
              seen.add(inner[1]);
              patterns.push({
                type: 'selector',
                description: `使用 ${inner[1]} 选择元素`,
                value: inner[1],
                urlPattern: this.extractPath(finalUrl),
                confidence: 0.6,
                useCount: 1,
                lastUsedAt: now,
                createdAt: now,
                source: 'agent_auto',
              });
            }
          }
        }
      }

      // 2. navigate success sequence → navigation_path (skip already-consumed indices)
      if (call.toolName === 'navigate' && call.args.url && !consumedNavIndices.has(i)) {
        const navSequence: string[] = [call.args.url];
        const seqIndices = [i];
        for (let j = i + 1; j < toolHistory.length && j < i + 5; j++) {
          if (toolHistory[j].toolName === 'navigate' && toolHistory[j].success && toolHistory[j].args.url) {
            navSequence.push(toolHistory[j].args.url);
            seqIndices.push(j);
          } else {
            break;
          }
        }
        if (navSequence.length >= 2) {
          const pathValue = navSequence.map(u => this.extractPath(u) || u).join(' → ');
          if (!seen.has(pathValue)) {
            seen.add(pathValue);
            for (const idx of seqIndices) consumedNavIndices.add(idx);
            patterns.push({
              type: 'navigation_path',
              description: `导航路径: ${pathValue}`,
              value: pathValue,
              confidence: 0.5,
              useCount: 1,
              lastUsedAt: now,
              createdAt: now,
              source: 'agent_auto',
            });
          }
        }
      }

      // 3. ask_human or result contains login/登录 → login_required
      if (call.toolName === 'ask_human') {
        const question = (call.args.question || '').toLowerCase();
        if (question.includes('login') || question.includes('登录') || question.includes('密码') || question.includes('password')) {
          const key = 'login_required';
          if (!seen.has(key)) {
            seen.add(key);
            patterns.push({
              type: 'login_required',
              description: '此站点需要登录',
              value: 'true',
              confidence: 0.9,
              useCount: 1,
              lastUsedAt: now,
              createdAt: now,
              source: 'agent_auto',
            });
          }
        }
      }

      // 4. get_page_content empty + execute_javascript success → spa_hint
      if (call.toolName === 'get_page_content' && i + 1 < toolHistory.length) {
        const next = toolHistory[i + 1];
        if (next.toolName === 'execute_javascript' && next.success) {
          const key = 'spa_hint';
          if (!seen.has(key)) {
            seen.add(key);
            const script = next.args.script || next.args.code || '';
            patterns.push({
              type: 'spa_hint',
              description: 'SPA 站点，需要通过 JS 提取内容',
              value: script.slice(0, 500),
              urlPattern: this.extractPath(finalUrl),
              confidence: 0.7,
              useCount: 1,
              lastUsedAt: now,
              createdAt: now,
              source: 'agent_auto',
            });
          }
        }
      }

      // 5. get_page_info with useful elements → page_structure
      if (call.toolName === 'get_page_info' && call.args) {
        // We record that get_page_info was useful at this URL
        const key = `page_structure:${this.extractPath(finalUrl)}`;
        if (!seen.has(key)) {
          seen.add(key);
          patterns.push({
            type: 'page_structure',
            description: `页面结构已通过 get_page_info 获取`,
            value: this.extractPath(finalUrl) || '/',
            urlPattern: this.extractPath(finalUrl),
            confidence: 0.5,
            useCount: 1,
            lastUsedAt: now,
            createdAt: now,
            source: 'agent_auto',
          });
        }
      }
    }

    return patterns;
  }

  /** Extract root domain from URL: www.bilibili.com → bilibili.com */
  static extractDomain(url: string): string {
    try {
      const hostname = new URL(url).hostname;
      // Remove www. prefix
      const parts = hostname.replace(/^www\./, '').split('.');
      // Handle cases like co.uk, com.cn etc.
      if (parts.length > 2) {
        const tld2 = parts.slice(-2).join('.');
        const knownTld2 = ['com.cn', 'co.uk', 'co.jp', 'com.au', 'com.br', 'org.cn', 'net.cn', 'co.kr', 'co.in', 'com.tw', 'com.hk', 'org.uk', 'ac.uk', 'com.sg', 'co.nz'];
        if (knownTld2.includes(tld2)) {
          return parts.slice(-3).join('.');
        }
      }
      return parts.length > 2 ? parts.slice(-2).join('.') : parts.join('.');
    } catch {
      return '';
    }
  }

  private static extractPath(url: string): string | undefined {
    try {
      return new URL(url).pathname;
    } catch {
      return undefined;
    }
  }
}

/** Merge new patterns into existing ones, dedup by value */
export function mergePatterns(existing: SitePattern[], incoming: SitePattern[]): SitePattern[] {
  const byValue = new Map<string, SitePattern>();
  for (const p of existing) {
    byValue.set(p.value, p);
  }
  for (const p of incoming) {
    const prev = byValue.get(p.value);
    if (prev) {
      // Boost confidence and update timestamp
      prev.confidence = Math.min(1.0, prev.confidence + 0.1);
      prev.useCount++;
      prev.lastUsedAt = Date.now();
    } else {
      byValue.set(p.value, p);
    }
  }
  return [...byValue.values()];
}
