import type { TrustLevel } from '../tool-context.js';

export interface TemplateMeta {
  templateId: string;
  version: string;
  name: string;
  description: string;
  trustLevelSupport: TrustLevel[];
  executionMode: 'sync' | 'async' | 'auto';
  limits: Record<string, number>;
}

const registry = new Map<string, TemplateMeta>();

function register(meta: TemplateMeta): void {
  registry.set(meta.templateId, meta);
}

// --- Register all templates ---

register({
  templateId: 'batch_extract_pages',
  version: '1.0.0',
  name: '批量页面结构化采集',
  description: '批量访问多个URL，提取页面语义信息和文本内容',
  trustLevelSupport: ['local', 'remote'],
  executionMode: 'auto',
  limits: { maxUrls: 1000, maxConcurrency: 5 },
});

register({
  templateId: 'login_keep_session',
  version: '1.0.0',
  name: '登录并保持会话',
  description: '自动登录指定网站并保存 cookie，后续请求自动携带登录态',
  trustLevelSupport: ['local'],
  executionMode: 'sync',
  limits: { maxRetries: 1 },
});

register({
  templateId: 'multi_tab_compare',
  version: '1.0.0',
  name: '多标签页对比',
  description: '在多个标签页中打开不同URL，提取并对比页面结构差异',
  trustLevelSupport: ['local', 'remote'],
  executionMode: 'auto',
  limits: { maxUrls: 10, maxConcurrency: 5 },
});

// --- Public API ---

export function getTemplate(id: string): TemplateMeta | undefined {
  return registry.get(id);
}

export function listTemplates(): TemplateMeta[] {
  return Array.from(registry.values());
}
