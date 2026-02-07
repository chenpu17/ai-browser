import { SemanticElement } from '../types/index.js';

export interface MatchCandidate {
  element: SemanticElement;
  score: number;
  matchReason: string;
}

// 中英文类型别名 → accessibility role 映射
const TYPE_ALIASES: Record<string, string[]> = {
  '搜索框': ['textbox', 'combobox'],
  '输入框': ['textbox', 'combobox'],
  '文本框': ['textbox'],
  '按钮': ['button'],
  '链接': ['link'],
  '复选框': ['checkbox'],
  '单选': ['radio'],
  '下拉': ['combobox'],
  '菜单': ['menuitem'],
  '标签页': ['tab'],
  'search': ['textbox', 'combobox'],
  'input': ['textbox', 'combobox'],
  'button': ['button'],
  'link': ['link'],
  'checkbox': ['checkbox'],
  'textbox': ['textbox'],
};

export class ElementMatcher {
  findByQuery(
    elements: SemanticElement[],
    query: string,
    limit: number = 5
  ): MatchCandidate[] {
    const queryLower = query.toLowerCase();
    const candidates: MatchCandidate[] = [];

    for (const element of elements) {
      const score = this.calculateScore(element, queryLower);
      if (score > 0) {
        candidates.push({
          element,
          score,
          matchReason: this.getMatchReason(element, queryLower),
        });
      }
    }

    return candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  findById(elements: SemanticElement[], id: string): SemanticElement | null {
    return elements.find((e) => e.id === id) || null;
  }

  private calculateScore(element: SemanticElement, query: string): number {
    let score = 0;
    const labelLower = element.label.toLowerCase();
    const idLower = element.id.toLowerCase();

    // 精确匹配ID
    if (idLower === query) return 1.0;

    // ID包含查询
    if (idLower.includes(query)) score += 0.8;

    // 标签精确匹配
    if (labelLower === query) score += 0.9;

    // 标签包含查询
    if (labelLower.includes(query)) score += 0.6;

    // 查询包含标签
    if (query.includes(labelLower) && labelLower.length > 2) score += 0.4;

    // 类型匹配（直接）
    if (element.type.toLowerCase().includes(query)) score += 0.3;

    // 类型别名匹配：搜索"搜索框"能匹配 textbox 类型元素
    const aliasRoles = TYPE_ALIASES[query];
    if (aliasRoles && aliasRoles.includes(element.type.toLowerCase())) {
      score += 0.5;
    }

    return Math.min(score, 1.0);
  }

  private getMatchReason(element: SemanticElement, query: string): string {
    const labelLower = element.label.toLowerCase();
    const idLower = element.id.toLowerCase();

    if (idLower === query) return 'exact_id_match';
    if (labelLower === query) return 'exact_label_match';
    if (idLower.includes(query)) return 'id_contains';
    if (labelLower.includes(query)) return 'label_contains';
    return 'partial_match';
  }
}
