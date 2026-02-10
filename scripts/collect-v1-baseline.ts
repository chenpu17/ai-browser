import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import Fastify from 'fastify';
import { BrowserManager } from '../src/browser/BrowserManager.js';
import { SessionManager } from '../src/browser/SessionManager.js';
import { CookieStore } from '../src/browser/CookieStore.js';
import { registerRoutes } from '../src/api/routes.js';

function fixtureUrl(name: string): string {
  return `file://${path.resolve('tests/fixtures', name)}`;
}

type Scenario = {
  id: string;
  payload: Record<string, unknown>;
};

type ScenarioResult = {
  id: string;
  success: boolean;
  taskId?: string;
  traceId?: string;
  ttdMs?: number;
  noHumanIntervention: boolean;
  error?: string;
};

const SCENARIOS: Scenario[] = [
  {
    id: 'batch_article_1',
    payload: {
      goal: '批量抓取页面',
      inputs: { urls: [fixtureUrl('article.html')] },
      constraints: { maxDurationMs: 20000, maxSteps: 20 },
      budget: { maxRetries: 0, maxToolCalls: 100 },
    },
  },
  {
    id: 'batch_form_1',
    payload: {
      goal: '批量抓取页面',
      inputs: { urls: [fixtureUrl('form.html')] },
      constraints: { maxDurationMs: 20000, maxSteps: 20 },
      budget: { maxRetries: 0, maxToolCalls: 100 },
    },
  },
  {
    id: 'batch_select_1',
    payload: {
      goal: '批量抓取页面',
      inputs: { urls: [fixtureUrl('select.html')] },
      constraints: { maxDurationMs: 20000, maxSteps: 20 },
      budget: { maxRetries: 0, maxToolCalls: 100 },
    },
  },
  {
    id: 'batch_long_1',
    payload: {
      goal: '批量抓取页面',
      inputs: { urls: [fixtureUrl('long-page.html')] },
      constraints: { maxDurationMs: 20000, maxSteps: 20 },
      budget: { maxRetries: 0, maxToolCalls: 100 },
    },
  },
  {
    id: 'compare_article_form',
    payload: {
      goal: '对比两个页面差异',
      inputs: { urls: [fixtureUrl('article.html'), fixtureUrl('form.html')] },
      constraints: { maxDurationMs: 30000, maxSteps: 20 },
      budget: { maxRetries: 0, maxToolCalls: 120 },
    },
  },
  {
    id: 'compare_form_select',
    payload: {
      goal: 'compare page differences',
      inputs: { urls: [fixtureUrl('form.html'), fixtureUrl('select.html')] },
      constraints: { maxDurationMs: 30000, maxSteps: 20 },
      budget: { maxRetries: 0, maxToolCalls: 120 },
    },
  },
  {
    id: 'batch_2_urls',
    payload: {
      goal: '批量抓取页面',
      inputs: { urls: [fixtureUrl('article.html'), fixtureUrl('select.html')] },
      constraints: { maxDurationMs: 30000, maxSteps: 20 },
      budget: { maxRetries: 0, maxToolCalls: 120 },
    },
  },
  {
    id: 'batch_3_urls',
    payload: {
      goal: '批量抓取页面',
      inputs: { urls: [fixtureUrl('article.html'), fixtureUrl('form.html'), fixtureUrl('select.html')] },
      constraints: { maxDurationMs: 30000, maxSteps: 25 },
      budget: { maxRetries: 0, maxToolCalls: 150 },
    },
  },
  {
    id: 'compare_article_long',
    payload: {
      goal: '比较页面内容变化',
      inputs: { urls: [fixtureUrl('article.html'), fixtureUrl('long-page.html')] },
      constraints: { maxDurationMs: 30000, maxSteps: 20 },
      budget: { maxRetries: 0, maxToolCalls: 120 },
    },
  },
  {
    id: 'batch_login_page',
    payload: {
      goal: '批量抓取页面',
      inputs: { urls: [fixtureUrl('login.html')] },
      constraints: { maxDurationMs: 20000, maxSteps: 20 },
      budget: { maxRetries: 0, maxToolCalls: 100 },
    },
  },
];

async function pollTaskDone(app: ReturnType<typeof Fastify>, taskId: string, timeoutMs = 30000): Promise<any> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const res = await app.inject({ method: 'GET', url: `/v1/tasks/${taskId}` });
    if (res.statusCode !== 200) {
      throw new Error(`get task failed: ${res.statusCode} ${res.body}`);
    }
    const body = JSON.parse(res.body);
    if (body.status === 'done') {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`task ${taskId} timeout`);
}

async function runScenario(app: ReturnType<typeof Fastify>, scenario: Scenario): Promise<ScenarioResult> {
  const create = await app.inject({
    method: 'POST',
    url: '/v1/tasks',
    payload: scenario.payload,
  });
  if (create.statusCode !== 200) {
    return {
      id: scenario.id,
      success: false,
      noHumanIntervention: false,
      error: `create failed: ${create.statusCode} ${create.body}`,
    };
  }

  const created = JSON.parse(create.body);
  const taskId = created.taskId as string;
  const traceId = created.traceId as string;

  try {
    const done = await pollTaskDone(app, taskId);
    const taskResult = done.result;
    const success = Boolean(taskResult?.success);
    const ttdMs = typeof done.createdAt === 'number' && typeof done.updatedAt === 'number'
      ? done.updatedAt - done.createdAt
      : undefined;

    return {
      id: scenario.id,
      success,
      taskId,
      traceId,
      ttdMs,
      noHumanIntervention: true,
      error: success ? undefined : (taskResult?.error || done.error || 'task failed'),
    };
  } catch (err: any) {
    return {
      id: scenario.id,
      success: false,
      taskId,
      traceId,
      noHumanIntervention: false,
      error: err.message || 'poll failed',
    };
  }
}

async function main() {
  const browserManager = new BrowserManager();
  await browserManager.launch({ headless: true });
  const sessionManager = new SessionManager(browserManager);

  const app = Fastify();
  registerRoutes(app, sessionManager, new CookieStore());
  await app.ready();

  const startedAt = Date.now();
  const results: ScenarioResult[] = [];

  try {
    for (const scenario of SCENARIOS) {
      // eslint-disable-next-line no-console
      console.log(`[baseline] running ${scenario.id}`);
      const result = await runScenario(app, scenario);
      results.push(result);
      // eslint-disable-next-line no-console
      console.log(`[baseline] ${scenario.id} -> ${result.success ? 'ok' : 'fail'}${result.error ? ` (${result.error})` : ''}`);
    }
  } finally {
    await sessionManager.closeAll().catch(() => {});
    await browserManager.close().catch(() => {});
    await app.close().catch(() => {});
  }

  const total = results.length;
  const successCount = results.filter((r) => r.success).length;
  const successRate = total === 0 ? 0 : successCount / total;
  const ttdValues = results.map((r) => r.ttdMs).filter((v): v is number => typeof v === 'number');
  const avgTtdMs = ttdValues.length === 0 ? null : Math.round(ttdValues.reduce((a, b) => a + b, 0) / ttdValues.length);
  const noHumanRate = total === 0 ? 0 : results.filter((r) => r.noHumanIntervention).length / total;
  const durationMs = Date.now() - startedAt;

  const report = {
    generatedAt: new Date().toISOString(),
    total,
    successCount,
    successRate,
    avgTtdMs,
    noHumanRate,
    durationMs,
    results,
  };

  const outDir = path.resolve('docs/reports');
  mkdirSync(outDir, { recursive: true });

  const jsonPath = path.join(outDir, 'v1-baseline.json');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');

  const mdLines = [
    '# v1 Baseline Report',
    '',
    `- GeneratedAt: ${report.generatedAt}`,
    `- Total: ${report.total}`,
    `- SuccessCount: ${report.successCount}`,
    `- SuccessRate: ${(report.successRate * 100).toFixed(1)}%`,
    `- AvgTTD(ms): ${report.avgTtdMs ?? 'N/A'}`,
    `- NoHumanRate: ${(report.noHumanRate * 100).toFixed(1)}%`,
    `- Duration(ms): ${report.durationMs}`,
    '',
    '## Scenario Results',
    '',
    '| Scenario | Success | TTD(ms) | Error |',
    '|---|---:|---:|---|',
    ...report.results.map((r) => `| ${r.id} | ${r.success ? 'Y' : 'N'} | ${r.ttdMs ?? '-'} | ${r.error ?? ''} |`),
    '',
  ];

  const mdPath = path.join(outDir, 'v1-baseline.md');
  writeFileSync(mdPath, mdLines.join('\n'), 'utf-8');

  // eslint-disable-next-line no-console
  console.log(`[baseline] report written: ${jsonPath}`);
  // eslint-disable-next-line no-console
  console.log(`[baseline] report written: ${mdPath}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[baseline] failed:', err);
  process.exit(1);
});
