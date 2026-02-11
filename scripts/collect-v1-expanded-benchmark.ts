import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BrowserManager } from '../src/browser/BrowserManager.js';
import { SessionManager } from '../src/browser/SessionManager.js';
import { createBrowserMcpServer } from '../src/mcp/browser-mcp-server.js';
import { enrichWithAiMarkdown } from '../src/mcp/ai-markdown.js';

function fixtureUrl(name: string): string {
  return `file://${path.resolve('tests/fixtures', name)}`;
}

type ScenarioResult = {
  id: string;
  success: boolean;
  notes: string;
  details?: Record<string, unknown>;
};

type ToolCallResult = {
  isError: boolean;
  data: any;
};

function parseResult(raw: any): any {
  const text = raw?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  const raw = await client.callTool({ name, arguments: args });
  return {
    isError: Boolean(raw?.isError),
    data: parseResult(raw),
  };
}

function hasAiEnvelope(data: any): boolean {
  return Boolean(
    data
    && typeof data.aiSchemaVersion === 'string'
    && typeof data.aiDetailLevel === 'string'
    && typeof data.aiSummary === 'string'
    && typeof data.aiMarkdown === 'string'
    && Array.isArray(data.aiHints)
    && Array.isArray(data.nextActions),
  );
}


async function scenarioSchemaRepairGuidance(): Promise<ScenarioResult> {
  const enriched = enrichWithAiMarkdown('get_task_run', {
    runId: 'run_schema_benchmark',
    status: 'failed',
    sessionId: 'sess_schema_benchmark',
    verification: {
      pass: false,
      missingFields: ['companyName', 'taxId'],
      typeMismatches: ['amount'],
      reason: 'schema verification failed',
    },
    schemaRepairHints: ['Missing fields: companyName, taxId'],
    artifactIds: ['artifact_schema_benchmark'],
  }) as any;

  const guidance = enriched?.schemaRepairGuidance;
  const nextActions = Array.isArray(enriched?.nextActions) ? enriched.nextActions : [];
  const hasRepairAction = nextActions.some((action: any) => action?.tool === 'get_page_content' || action?.tool === 'get_page_info');

  return {
    id: 'schema_repair_guidance',
    success: Boolean(
      guidance
      && Array.isArray(guidance.missingFields)
      && guidance.missingFields.length > 0
      && hasRepairAction,
    ),
    notes: `missing=${guidance?.missingFields?.length ?? 0}, type=${guidance?.typeMismatches?.length ?? 0}`,
    details: {
      guidance,
      nextActions,
      aiSummary: enriched?.aiSummary,
    },
  };
}

async function scenarioAdaptiveTaskPolling(client: Client): Promise<ScenarioResult> {
  const runSubmit = await callTool(client, 'run_task_template', {
    templateId: 'batch_extract_pages',
    inputs: { urls: [fixtureUrl('long-page.html'), fixtureUrl('article.html'), fixtureUrl('form.html')] },
    options: { mode: 'async' },
  });

  if (runSubmit.isError || !runSubmit.data?.runId) {
    return {
      id: 'adaptive_task_polling',
      success: false,
      notes: 'run_task_template async submission failed',
      details: { error: runSubmit.data?.error },
    };
  }

  const runId = runSubmit.data.runId as string;
  const firstPoll = await callTool(client, 'get_task_run', { runId });
  if (firstPoll.isError || !firstPoll.data) {
    return {
      id: 'adaptive_task_polling',
      success: false,
      notes: 'get_task_run failed',
      details: { runId, error: firstPoll.data?.error },
    };
  }

  const status = String(firstPoll.data.status || 'unknown');
  const level = String(firstPoll.data.aiDetailLevel || '-');
  const policy = firstPoll.data.aiDetailPolicy;

  const expected = status === 'running' || status === 'queued' ? level === 'brief' : true;
  return {
    id: 'adaptive_task_polling',
    success: hasAiEnvelope(firstPoll.data) && Boolean(policy?.reason) && expected,
    notes: `status=${status}, detail=${level}`,
    details: { runId, status, level, policy },
  };
}

async function scenarioDeltaTaskRun(client: Client): Promise<ScenarioResult> {
  const runSubmit = await callTool(client, 'run_task_template', {
    templateId: 'batch_extract_pages',
    inputs: { urls: [fixtureUrl('article.html')] },
    options: { mode: 'async' },
  });

  if (runSubmit.isError || !runSubmit.data?.runId) {
    return {
      id: 'delta_task_run',
      success: false,
      notes: 'run_task_template async submission failed',
      details: { error: runSubmit.data?.error },
    };
  }

  const runId = runSubmit.data.runId as string;
  const first = await callTool(client, 'get_task_run', { runId });
  await delay(300);
  const second = await callTool(client, 'get_task_run', { runId });

  const firstDelta = first.data?.deltaSummary;
  const secondDelta = second.data?.deltaSummary;

  const ok = !first.isError
    && !second.isError
    && firstDelta
    && Array.isArray(firstDelta.changes)
    && secondDelta
    && Array.isArray(secondDelta.changes)
    && secondDelta.changes.length > 0;

  return {
    id: 'delta_task_run',
    success: Boolean(ok),
    notes: `first=${firstDelta?.changes?.join(' | ') || '-'}; second=${secondDelta?.changes?.join(' | ') || '-'}`,
    details: { runId, firstDelta, secondDelta, status: second.data?.status },
  };
}

async function scenarioDeltaConsoleLogs(client: Client): Promise<ScenarioResult> {
  const created = await callTool(client, 'create_session', {});
  const sessionId = created.data?.sessionId as string;
  if (created.isError || !sessionId) {
    return {
      id: 'delta_console_logs',
      success: false,
      notes: 'create_session failed',
      details: { error: created.data?.error },
    };
  }

  try {
    await callTool(client, 'navigate', { sessionId, url: fixtureUrl('article.html') });
    await callTool(client, 'execute_javascript', {
      sessionId,
      script: "console.error('expanded-delta-1'); return true;",
    });

    const first = await callTool(client, 'get_console_logs', { sessionId, level: 'all', maxEntries: 1 });
    await callTool(client, 'execute_javascript', {
      sessionId,
      script: "console.error('expanded-delta-2'); return true;",
    });
    const second = await callTool(client, 'get_console_logs', { sessionId, level: 'all', maxEntries: 1 });

    const ok = !first.isError
      && !second.isError
      && first.data?.deltaSummary
      && second.data?.deltaSummary
      && Array.isArray(second.data.deltaSummary.changes)
      && second.data.deltaSummary.changes.length > 0;

    return {
      id: 'delta_console_logs',
      success: Boolean(ok),
      notes: `second delta: ${(second.data?.deltaSummary?.changes || []).join(' | ')}`,
      details: {
        firstDelta: first.data?.deltaSummary,
        secondDelta: second.data?.deltaSummary,
      },
    };
  } finally {
    await callTool(client, 'close_session', { sessionId });
  }
}

async function scenarioRunListPagination(client: Client): Promise<ScenarioResult> {
  for (let i = 0; i < 3; i += 1) {
    await callTool(client, 'run_task_template', {
      templateId: 'batch_extract_pages',
      inputs: { urls: [fixtureUrl('article.html')] },
      options: { mode: 'sync' },
    });
  }

  const first = await callTool(client, 'list_task_runs', { limit: 1, offset: 0 });
  if (first.isError || !first.data) {
    return {
      id: 'run_list_pagination',
      success: false,
      notes: 'list_task_runs first page failed',
      details: { error: first.data?.error },
    };
  }

  const cursor = first.data.nextCursor;
  const second = cursor
    ? await callTool(client, 'list_task_runs', cursor)
    : null;

  const ok = hasAiEnvelope(first.data)
    && first.data.deltaSummary
    && (!second || (!second.isError && hasAiEnvelope(second.data)));

  return {
    id: 'run_list_pagination',
    success: Boolean(ok),
    notes: `hasMore=${Boolean(first.data.hasMore)}, cursor=${JSON.stringify(cursor)}`,
    details: {
      firstDelta: first.data.deltaSummary,
      secondDelta: second?.data?.deltaSummary,
    },
  };
}

async function scenarioPartialFailureMix(client: Client): Promise<ScenarioResult> {
  const mixed = await callTool(client, 'run_task_template', {
    templateId: 'batch_extract_pages',
    inputs: {
      urls: [fixtureUrl('article.html'), 'http://127.0.0.1:9/unreachable-expanded-benchmark'],
    },
    options: { mode: 'sync' },
  });

  if (mixed.isError || !mixed.data) {
    return {
      id: 'partial_failure_mix',
      success: false,
      notes: 'mixed URL run failed before result',
      details: { error: mixed.data?.error },
    };
  }

  const status = String(mixed.data.status || 'unknown');
  return {
    id: 'partial_failure_mix',
    success: hasAiEnvelope(mixed.data) && ['succeeded', 'partial_success', 'failed'].includes(status),
    notes: `status=${status}`,
    details: {
      status,
      summary: mixed.data.result?.summary,
      aiSummary: mixed.data.aiSummary,
    },
  };
}

async function main() {
  const originalAdaptive = process.env.AI_MARKDOWN_ADAPTIVE_POLICY;
  const originalDetail = process.env.AI_MARKDOWN_DETAIL_LEVEL;

  process.env.AI_MARKDOWN_ADAPTIVE_POLICY = '1';
  process.env.AI_MARKDOWN_DETAIL_LEVEL = 'normal';

  let browserManager: BrowserManager | null = null;
  let sessionManager: SessionManager | null = null;
  let mcpServer: McpServer | null = null;
  let mcpClient: Client | null = null;

  try {
    browserManager = new BrowserManager();
    await browserManager.launch({ headless: true });
    sessionManager = new SessionManager(browserManager);

    mcpServer = createBrowserMcpServer(sessionManager, undefined, {
      urlValidation: { allowFile: true },
    });

    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(st);

    mcpClient = new Client({ name: 'expanded-benchmark', version: '0.1.0' });
    await mcpClient.connect(ct);

    const startedAt = Date.now();
    const scenarioResults: ScenarioResult[] = [];

    const scenarioFns: Array<() => Promise<ScenarioResult>> = [
      () => scenarioSchemaRepairGuidance(),
      () => scenarioAdaptiveTaskPolling(mcpClient!),
      () => scenarioDeltaTaskRun(mcpClient!),
      () => scenarioDeltaConsoleLogs(mcpClient!),
      () => scenarioRunListPagination(mcpClient!),
      () => scenarioPartialFailureMix(mcpClient!),
    ];

    for (const run of scenarioFns) {
      const result = await run();
      scenarioResults.push(result);
      // eslint-disable-next-line no-console
      console.log(`[expanded] ${result.id} -> ${result.success ? 'ok' : 'fail'} (${result.notes})`);
    }

    const total = scenarioResults.length;
    const passed = scenarioResults.filter((r) => r.success).length;
    const passRate = total === 0 ? 0 : passed / total;

    const deltaCoverage = scenarioResults
      .filter((r) => ['delta_task_run', 'delta_console_logs', 'run_list_pagination'].includes(r.id));
    const deltaCoverageRate = deltaCoverage.length === 0
      ? 0
      : deltaCoverage.filter((r) => r.success).length / deltaCoverage.length;

    const adaptiveCoverage = scenarioResults
      .filter((r) => ['adaptive_task_polling'].includes(r.id));
    const adaptiveCoverageRate = adaptiveCoverage.length === 0
      ? 0
      : adaptiveCoverage.filter((r) => r.success).length / adaptiveCoverage.length;

    const schemaGuidanceCoverage = scenarioResults
      .filter((r) => ['schema_repair_guidance'].includes(r.id));
    const schemaGuidanceCoverageRate = schemaGuidanceCoverage.length === 0
      ? 0
      : schemaGuidanceCoverage.filter((r) => r.success).length / schemaGuidanceCoverage.length;

    const report = {
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      total,
      passed,
      passRate,
      deltaCoverageRate,
      adaptiveCoverageRate,
      schemaGuidanceCoverageRate,
      scenarioResults,
    };

    const outDir = path.resolve('docs/reports');
    mkdirSync(outDir, { recursive: true });

    const jsonPath = path.join(outDir, 'v1-expanded-benchmark.json');
    const mdPath = path.join(outDir, 'v1-expanded-benchmark.md');
    writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');

    const mdLines = [
      '# v1 Expanded Readability Benchmark',
      '',
      `- GeneratedAt: ${report.generatedAt}`,
      `- Duration(ms): ${report.durationMs}`,
      `- TotalScenarios: ${report.total}`,
      `- Passed: ${report.passed}`,
      `- PassRate: ${(report.passRate * 100).toFixed(1)}%`,
      `- DeltaCoverageRate: ${(report.deltaCoverageRate * 100).toFixed(1)}%`,
      `- AdaptiveCoverageRate: ${(report.adaptiveCoverageRate * 100).toFixed(1)}%`,
      `- SchemaGuidanceCoverageRate: ${(report.schemaGuidanceCoverageRate * 100).toFixed(1)}%`,
      '',
      '## Scenario Results',
      '',
      '| Scenario | Success | Notes |',
      '|---|---:|---|',
      ...report.scenarioResults.map((item) => `| ${item.id} | ${item.success ? 'Y' : 'N'} | ${item.notes} |`),
      '',
    ];

    writeFileSync(mdPath, mdLines.join('\n'), 'utf-8');

    // eslint-disable-next-line no-console
    console.log(`[expanded] report written: ${jsonPath}`);
    // eslint-disable-next-line no-console
    console.log(`[expanded] report written: ${mdPath}`);
  } finally {
    if (mcpClient) {
      await mcpClient.close().catch(() => {});
    }
    if (mcpServer) {
      await mcpServer.close().catch(() => {});
    }
    if (sessionManager) {
      await sessionManager.closeAll().catch(() => {});
    }
    if (browserManager) {
      await browserManager.close().catch(() => {});
    }

    if (originalAdaptive === undefined) {
      delete process.env.AI_MARKDOWN_ADAPTIVE_POLICY;
    } else {
      process.env.AI_MARKDOWN_ADAPTIVE_POLICY = originalAdaptive;
    }

    if (originalDetail === undefined) {
      delete process.env.AI_MARKDOWN_DETAIL_LEVEL;
    } else {
      process.env.AI_MARKDOWN_DETAIL_LEVEL = originalDetail;
    }
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[expanded] failed:', err);
  process.exit(1);
});
