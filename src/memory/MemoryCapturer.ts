import type { ToolCallRecord } from '../agent/tool-usage-tracker.js';
import type { SitePattern, KnowledgeCard } from './types.js';

interface PatternExtractionOptions {
  taskText?: string;
  finalResult?: unknown;
}

export interface DomainToolHistory {
  domain: string;
  finalUrl: string;
  history: ToolCallRecord[];
}

export class MemoryCapturer {
  /**
   * Extract reusable patterns from a successful agent run's tool history.
   */
  static extractPatterns(
    toolHistory: readonly ToolCallRecord[],
    finalUrl: string,
    options: PatternExtractionOptions = {},
  ): SitePattern[] {
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

    const taskIntent = this.buildTaskIntentPattern(toolHistory, options.taskText, options.finalResult, finalUrl, now);
    if (taskIntent && !seen.has(taskIntent.value)) {
      seen.add(taskIntent.value);
      patterns.push(taskIntent);
    }

    return patterns;
  }

  static splitHistoryByDomain(toolHistory: readonly ToolCallRecord[]): DomainToolHistory[] {
    const grouped = new Map<string, DomainToolHistory>();
    let currentDomain = '';

    for (const call of toolHistory) {
      const navigatedUrl = this.extractToolUrl(call);
      if (navigatedUrl) {
        const domain = this.extractDomain(navigatedUrl);
        if (domain) {
          currentDomain = domain;
          const entry = grouped.get(domain) ?? { domain, finalUrl: navigatedUrl, history: [] };
          entry.finalUrl = navigatedUrl;
          entry.history.push(call);
          grouped.set(domain, entry);
          continue;
        }
      }

      if (!currentDomain) continue;
      const entry = grouped.get(currentDomain);
      if (!entry) continue;
      entry.history.push(call);
    }

    return Array.from(grouped.values());
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

  private static extractToolUrl(call: ToolCallRecord): string | null {
    if (!call.success) return null;
    if ((call.toolName === 'navigate' || call.toolName === 'navigate_and_extract') && typeof call.args.url === 'string') {
      return call.args.url;
    }
    return null;
  }

  private static buildTaskIntentPattern(
    toolHistory: readonly ToolCallRecord[],
    taskText?: string,
    finalResult?: unknown,
    finalUrl?: string,
    now = Date.now(),
  ): SitePattern | null {
    const normalizedTask = taskText?.trim();
    if (!normalizedTask) return null;

    const actionHints = this.summarizeActionHints(toolHistory, finalUrl);
    const actionableHints = actionHints.filter((hint) => !hint.startsWith('落点'));
    const resultPreview = this.summarizeResult(finalResult);
    if (normalizedTask.length < 4) return null;
    if (this.isGenericTask(normalizedTask) && actionableHints.length === 0 && !resultPreview) {
      return null;
    }

    const parts = [
      normalizedTask.slice(0, 180),
      finalUrl ? `路径:${this.extractPath(finalUrl) || finalUrl}` : '',
      actionHints.length > 0 ? `关键步骤:${actionHints.join(', ')}` : '',
      resultPreview ? `结果:${resultPreview}` : '',
    ].filter(Boolean);
    const value = parts.join(' | ');

    return {
      type: 'task_intent',
      description: `任务经验: ${normalizedTask.slice(0, 120)}`,
      value: value.slice(0, 400),
      urlPattern: this.extractPath(finalUrl ?? ''),
      confidence: actionHints.length > 0 ? 0.8 : 0.7,
      useCount: 1,
      lastUsedAt: now,
      createdAt: now,
      source: 'agent_auto',
    };
  }

  private static summarizeResult(finalResult: unknown): string {
    if (finalResult === null || finalResult === undefined) return '';
    if (typeof finalResult === 'string') return finalResult.slice(0, 200);
    if (typeof finalResult === 'object' && !Array.isArray(finalResult) && Object.keys(finalResult as Record<string, unknown>).length === 0) {
      return '';
    }

    try {
      return JSON.stringify(finalResult).slice(0, 200);
    } catch {
      return String(finalResult).slice(0, 200);
    }
  }

  private static summarizeActionHints(toolHistory: readonly ToolCallRecord[], finalUrl?: string): string[] {
    const hints: string[] = [];
    const seen = new Set<string>();

    if (finalUrl) {
      const path = this.extractPath(finalUrl);
      if (path) {
        hints.push(`落点${path}`);
        seen.add(`path:${path}`);
      }
    }

    for (const call of toolHistory) {
      if (!call.success) continue;

      if (call.toolName === 'find_element' && typeof call.args.query === 'string') {
        const query = call.args.query.trim();
        if (query && !seen.has(`query:${query}`)) {
          seen.add(`query:${query}`);
          hints.push(`查找${query.slice(0, 30)}`);
        }
      }

      if (call.toolName === 'click' && typeof call.args.elementId === 'string') {
        const elementId = call.args.elementId.trim();
        if (elementId && !seen.has(`click:${elementId}`)) {
          seen.add(`click:${elementId}`);
          hints.push(`点击${elementId.slice(0, 30)}`);
        }
      }

      if (call.toolName === 'execute_javascript') {
        const script = String(call.args.script || call.args.code || '');
        const match = script.match(/querySelector(?:All)?\(\s*['"`]([^'"`]+)['"`]\s*\)/);
        if (match?.[1] && !seen.has(`selector:${match[1]}`)) {
          seen.add(`selector:${match[1]}`);
          hints.push(`选择器${match[1].slice(0, 30)}`);
        }
      }

      if (hints.length >= 3) break;
    }

    return hints.slice(0, 3);
  }

  private static isGenericTask(taskText: string): boolean {
    const normalized = taskText.trim().toLowerCase();
    return /^(打开|浏览|看看|查看|总结|探索|open|visit|browse|explore|summarize)/i.test(normalized);
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
