import type { TrustLevel } from '../tool-context.js';

export interface TemplateMeta {
  templateId: string;
  version: string;
  name: string;
  description: string;
  exampleInputs?: Record<string, unknown>;
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
  exampleInputs: {
    urls: ['https://example.com/a', 'https://example.com/b'],
    extract: { pageInfo: true, content: true, maxElements: 50, maxContentLength: 4000 },
    concurrency: 3,
  },
  trustLevelSupport: ['local', 'remote'],
  executionMode: 'auto',
  limits: { maxUrls: 1000, maxConcurrency: 5 },
});

register({
  templateId: 'login_keep_session',
  version: '1.0.0',
  name: '登录并保持会话',
  description: '自动登录指定网站并保存 cookie，后续请求自动携带登录态',
  exampleInputs: {
    startUrl: 'https://example.com/login',
    credentials: { username: 'alice', password: 'secret' },
    fields: {
      mode: 'selector',
      usernameSelector: '#username',
      passwordSelector: '#password',
      submitSelector: '#submit',
    },
    successIndicator: { type: 'urlContains', value: '/dashboard' },
  },
  trustLevelSupport: ['local'],
  executionMode: 'sync',
  limits: { maxRetries: 1 },
});

register({
  templateId: 'multi_tab_compare',
  version: '1.0.0',
  name: '多标签页对比',
  description: '在多个标签页中打开不同URL，提取并对比页面结构差异',
  exampleInputs: {
    urls: ['https://example.com/a', 'https://example.com/b'],
    extract: { pageInfo: true, content: true },
    compare: { fields: ['title', 'elementCount', 'topSections'], topSections: 3 },
  },
  trustLevelSupport: ['local', 'remote'],
  executionMode: 'auto',
  limits: { maxUrls: 10, maxConcurrency: 5 },
});

register({
  templateId: 'search_extract',
  version: '1.0.0',
  name: '搜索后提取',
  description: '输入搜索词，进入结果页或目标结果后提取页面结构和内容',
  exampleInputs: {
    startUrl: 'https://example.com/search',
    query: 'laptop',
    searchField: { mode: 'selector', selector: 'input[type="search"]' },
    submit: { mode: 'selector', selector: 'button[type="submit"]' },
    openResult: { mode: 'selector', selector: '.result a' },
    waitForResults: { type: 'stable' },
    extract: { pageInfo: true, content: true },
  },
  trustLevelSupport: ['local', 'remote'],
  executionMode: 'sync',
  limits: { maxSteps: 6 },
});

register({
  templateId: 'paginated_extract',
  version: '1.0.0',
  name: '列表翻页采集',
  description: '按下一页控件依次翻页并采集每一页的结构化结果',
  exampleInputs: {
    startUrl: 'https://example.com/list',
    pagination: {
      next: { mode: 'selector', selector: '.pagination-next' },
      maxPages: 3,
      waitFor: { type: 'stable' },
    },
    extract: { pageInfo: true, content: true },
  },
  trustLevelSupport: ['local', 'remote'],
  executionMode: 'sync',
  limits: { maxPages: 50 },
});

register({
  templateId: 'submit_and_verify',
  version: '1.0.0',
  name: '表单提交后验证',
  description: '填写表单、提交动作并根据成功条件验证结果页面',
  exampleInputs: {
    startUrl: 'https://example.com/form',
    fields: [
      {
        name: 'email',
        value: 'alice@example.com',
        locator: { mode: 'selector', selector: '#email' },
      },
    ],
    submit: { mode: 'selector', selector: 'button[type="submit"]' },
    successIndicator: { type: 'textIncludes', value: 'Thanks for submitting' },
    extract: { pageInfo: true, content: true },
  },
  trustLevelSupport: ['local', 'remote'],
  executionMode: 'sync',
  limits: { maxFields: 20 },
});

// --- Public API ---

export function getTemplate(id: string): TemplateMeta | undefined {
  return registry.get(id);
}

export function listTemplates(): TemplateMeta[] {
  return Array.from(registry.values());
}
