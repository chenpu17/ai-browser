import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import Fastify from 'fastify';
import { BrowserManager } from '../src/browser/BrowserManager.js';
import { SessionManager } from '../src/browser/SessionManager.js';
import { CookieStore } from '../src/browser/CookieStore.js';
import { registerRoutes } from '../src/api/routes.js';

const RUNS = 100;

function fixtureUrl(name: string): string {
  return `file://${path.resolve('tests/fixtures', name)}`;
}

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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`task ${taskId} timeout`);
}

async function runOnce(app: ReturnType<typeof Fastify>, idx: number) {
  const payload = {
    goal: '批量提取页面信息',
    inputs: { urls: [fixtureUrl('article.html')] },
    constraints: { maxDurationMs: 15000, maxSteps: 20 },
    budget: { maxRetries: 0, maxToolCalls: 80 },
    outputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array' },
      },
    },
  };

  const start = Date.now();
  const create = await app.inject({
    method: 'POST',
    url: '/v1/tasks',
    payload,
  });

  if (create.statusCode !== 200) {
    return {
      index: idx,
      success: false,
      durationMs: Date.now() - start,
      error: `create failed: ${create.statusCode}`,
    };
  }

  const created = JSON.parse(create.body);
  try {
    const done = await pollTaskDone(app, created.taskId, 20000);
    const resultSuccess = Boolean(done?.result?.success);
    return {
      index: idx,
      success: resultSuccess,
      durationMs: Date.now() - start,
      error: resultSuccess ? undefined : (done?.result?.error || done?.error || 'task failed'),
    };
  } catch (err: any) {
    return {
      index: idx,
      success: false,
      durationMs: Date.now() - start,
      error: err?.message || 'poll failed',
    };
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(rank, sorted.length - 1))];
}

async function main() {
  const browserManager = new BrowserManager();
  await browserManager.launch({ headless: true });
  const sessionManager = new SessionManager(browserManager);

  const app = Fastify();
  registerRoutes(app, sessionManager, new CookieStore());
  await app.ready();

  const startedAt = Date.now();
  const results: Array<{ index: number; success: boolean; durationMs: number; error?: string }> = [];

  try {
    for (let i = 0; i < RUNS; i++) {
      // eslint-disable-next-line no-console
      console.log(`[stress] run ${i + 1}/${RUNS}`);
      const one = await runOnce(app, i + 1);
      results.push(one);
    }
  } finally {
    await sessionManager.closeAll().catch(() => {});
    await browserManager.close().catch(() => {});
    await app.close().catch(() => {});
  }

  const total = results.length;
  const successes = results.filter((r) => r.success).length;
  const successRate = total > 0 ? successes / total : 0;
  const latencies = results.map((r) => r.durationMs);
  const avgLatencyMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  const p95LatencyMs = percentile(latencies, 95);
  const durationMs = Date.now() - startedAt;

  const report = {
    generatedAt: new Date().toISOString(),
    runs: RUNS,
    successRate,
    successes,
    failures: total - successes,
    avgLatencyMs,
    p95LatencyMs,
    durationMs,
    results,
  };

  const outDir = path.resolve('docs/reports');
  mkdirSync(outDir, { recursive: true });

  const jsonPath = path.join(outDir, 'v1-stress-100.json');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');

  const mdPath = path.join(outDir, 'v1-stress-100.md');
  const md = [
    '# v1 Stress Report (100 runs)',
    '',
    `- GeneratedAt: ${report.generatedAt}`,
    `- Runs: ${report.runs}`,
    `- SuccessRate: ${(report.successRate * 100).toFixed(1)}%`,
    `- Successes: ${report.successes}`,
    `- Failures: ${report.failures}`,
    `- AvgLatency(ms): ${report.avgLatencyMs}`,
    `- P95Latency(ms): ${report.p95LatencyMs}`,
    `- Duration(ms): ${report.durationMs}`,
    '',
  ].join('\n');
  writeFileSync(mdPath, md, 'utf-8');

  // eslint-disable-next-line no-console
  console.log(`[stress] report written: ${jsonPath}`);
  // eslint-disable-next-line no-console
  console.log(`[stress] report written: ${mdPath}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[stress] failed:', err);
  process.exit(1);
});
