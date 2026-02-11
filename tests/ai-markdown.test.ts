import { describe, expect, it } from 'vitest';
import { enrichWithAiMarkdown } from '../src/mcp/ai-markdown.js';

describe('enrichWithAiMarkdown', () => {
  it('returns original payload for unknown tools', () => {
    const payload = { success: true };
    const enriched = enrichWithAiMarkdown('unknown_tool', payload) as any;
    expect(enriched).toBe(payload);
  });

  it('adds ai helper fields for navigate', () => {
    const payload = {
      success: true,
      partial: false,
      page: { url: 'https://example.com', title: 'Example Domain' },
      statusCode: 200,
    };

    const enriched = enrichWithAiMarkdown('navigate', payload) as any;
    expect(enriched.aiSummary).toContain('Navigation completed');
    expect(enriched.aiMarkdown).toContain('## Navigation Result');
    expect(enriched.aiMarkdown).toContain('HTTP Status: 200');
    expect(Array.isArray(enriched.aiHints)).toBe(true);
    expect(enriched.aiHints[0]).toContain('get_page_info');
    expect(enriched.aiSchemaVersion).toBe('1.0');
    expect(enriched.aiDetailLevel).toBe('normal');
    expect(Array.isArray(enriched.nextActions)).toBe(true);
    expect(enriched.nextActions[0]?.tool).toBe('get_page_info');
  });

  it('adds compact element table for get_page_info', () => {
    const payload = {
      page: { url: 'https://example.com', title: 'Example', type: 'generic', summary: 'Sample summary' },
      elements: [
        { id: 'btn_submit_1', type: 'button', label: 'Submit', state: { disabled: false } },
      ],
      recommendedByIntent: [{ intent: 'submit_form', suggestedElementIds: ['btn_submit_1'] }],
      truncated: false,
      totalElements: 1,
    };

    const enriched = enrichWithAiMarkdown('get_page_info', payload) as any;
    expect(enriched.aiSummary).toContain('interactive elements');
    expect(enriched.aiMarkdown).toContain('## Page Interaction Snapshot');
    expect(enriched.aiMarkdown).toContain('| id | type | label | state |');
    expect(enriched.aiMarkdown).toContain('`btn_submit_1`');
    expect(enriched.aiMarkdown).toContain('Recommended By Intent');
    expect(enriched.nextActions[0]?.tool).toBe('click');
  });


  it('formats session and task catalog helper markdown', () => {
    const createSession = enrichWithAiMarkdown('create_session', { sessionId: 'sess_1' }) as any;
    expect(createSession.aiSummary).toContain('Session created');
    expect(createSession.aiMarkdown).toContain('## Session Created');

    const closeSession = enrichWithAiMarkdown('close_session', {
      success: true,
      kept: true,
      reason: 'headful session preserved',
    }) as any;
    expect(closeSession.aiSummary).toContain('kept=headful');
    expect(closeSession.aiMarkdown).toContain('## Session Close Result');

    const script = enrichWithAiMarkdown('execute_javascript', {
      result: { ok: true },
      truncated: false,
    }) as any;
    expect(script.aiSummary).toContain('JavaScript executed');
    expect(script.aiMarkdown).toContain('## JavaScript Execution Result');

    const screenshot = enrichWithAiMarkdown('screenshot', {
      captured: true,
      url: 'https://example.com',
      title: 'Example',
      fullPage: true,
    }) as any;
    expect(screenshot.aiSummary).toContain('Screenshot captured');
    expect(screenshot.aiMarkdown).toContain('## Screenshot Captured');

    const templates = enrichWithAiMarkdown('list_task_templates', {
      templates: [{ templateId: 'batch_extract_pages', version: '1.0.0', executionMode: 'sync' }],
    }) as any;
    expect(templates.aiSummary).toContain('task templates');
    expect(templates.aiMarkdown).toContain('## Task Template List');

    const profile = enrichWithAiMarkdown('get_runtime_profile', {
      maxConcurrentRuns: 5,
      trustLevel: 'local',
      supportedModes: ['sync', 'async', 'auto'],
    }) as any;
    expect(profile.aiSummary).toContain('Runtime profile');
    expect(profile.aiMarkdown).toContain('## Runtime Profile');
  });

  it('formats tab, dialog, network and console helper markdown', () => {
    const tabs = enrichWithAiMarkdown('list_tabs', {
      activeTabId: 'tab_2',
      tabs: [
        { id: 'tab_1', title: 'First', url: 'https://example.com/1' },
        { id: 'tab_2', title: 'Second', url: 'https://example.com/2' },
      ],
    }) as any;
    expect(tabs.aiSummary).toContain('Listed 2 tabs');
    expect(tabs.aiMarkdown).toContain('## Tab List');

    const dialog = enrichWithAiMarkdown('get_dialog_info', {
      pendingDialog: { type: 'alert', message: 'Hello' },
      dialogHistory: [{ type: 'alert', message: 'Hello', handled: true }],
    }) as any;
    expect(dialog.aiSummary).toContain('pending=yes');
    expect(dialog.aiMarkdown).toContain('## Dialog Status');

    const net = enrichWithAiMarkdown('get_network_logs', {
      logs: [{ method: 'GET', status: 200, resourceType: 'document', url: 'https://example.com' }],
      totalCount: 1,
      truncated: true,
      hasMore: true,
      nextCursor: { suggestedMaxEntries: 100 },
    }) as any;
    expect(net.aiSummary).toContain('returned 1/1');
    expect(net.aiMarkdown).toContain('## Network Logs');
    expect(net.nextActions[0]).toMatchObject({ tool: 'get_network_logs', args: { maxEntries: 100 } });

    const consoleLogs = enrichWithAiMarkdown('get_console_logs', {
      logs: [{ level: 'error', text: 'boom', timestamp: 1739188800000 }],
      truncated: true,
      hasMore: true,
      nextCursor: { suggestedMaxEntries: 120 },
    }) as any;
    expect(consoleLogs.aiSummary).toContain('error=1');
    expect(consoleLogs.aiMarkdown).toContain('## Console Logs');
    expect(consoleLogs.nextActions[0]).toMatchObject({ tool: 'get_console_logs', args: { maxEntries: 120 } });
  });

  it('respects detail level from environment', () => {
    const previous = process.env.AI_MARKDOWN_DETAIL_LEVEL;
    process.env.AI_MARKDOWN_DETAIL_LEVEL = 'brief';

    try {
      const enriched = enrichWithAiMarkdown('list_tabs', {
        activeTabId: 'tab_1',
        tabs: [
          { id: 'tab_1', title: 'A', url: 'https://example.com/a' },
          { id: 'tab_2', title: 'B', url: 'https://example.com/b' },
        ],
      }) as any;

      expect(enriched.aiDetailLevel).toBe('brief');
      expect(enriched.nextActions.length).toBeLessThanOrEqual(1);
    } finally {
      if (previous === undefined) {
        delete process.env.AI_MARKDOWN_DETAIL_LEVEL;
      } else {
        process.env.AI_MARKDOWN_DETAIL_LEVEL = previous;
      }
    }
  });


  it('supports adaptive detail policy for polling and failure states', () => {
    const previousDetail = process.env.AI_MARKDOWN_DETAIL_LEVEL;
    const previousAdaptive = process.env.AI_MARKDOWN_ADAPTIVE_POLICY;
    process.env.AI_MARKDOWN_DETAIL_LEVEL = 'normal';
    process.env.AI_MARKDOWN_ADAPTIVE_POLICY = '1';

    try {
      const running = enrichWithAiMarkdown('get_task_run', {
        runId: 'run_adaptive',
        status: 'running',
        progress: { doneSteps: 1, totalSteps: 3 },
      }) as any;
      expect(running.aiDetailLevel).toBe('brief');
      expect(running.aiDetailPolicy?.mode).toBe('adaptive');

      const failed = enrichWithAiMarkdown('get_task_run', {
        runId: 'run_adaptive',
        status: 'failed',
        error: { message: 'boom' },
      }) as any;
      expect(failed.aiDetailLevel).toBe('full');
      expect(failed.aiDetailPolicy?.mode).toBe('adaptive');

      const explicit = enrichWithAiMarkdown('get_task_run', {
        runId: 'run_adaptive_explicit',
        status: 'running',
        aiDetailLevel: 'full',
      }) as any;
      expect(explicit.aiDetailLevel).toBe('full');
      expect(explicit.aiDetailPolicy?.source).toBe('data');
    } finally {
      if (previousDetail === undefined) {
        delete process.env.AI_MARKDOWN_DETAIL_LEVEL;
      } else {
        process.env.AI_MARKDOWN_DETAIL_LEVEL = previousDetail;
      }

      if (previousAdaptive === undefined) {
        delete process.env.AI_MARKDOWN_ADAPTIVE_POLICY;
      } else {
        process.env.AI_MARKDOWN_ADAPTIVE_POLICY = previousAdaptive;
      }
    }
  });

  it('adds progress-aware hints for get_task_run', () => {
    const running = enrichWithAiMarkdown('get_task_run', {
      runId: 'run_1',
      status: 'running',
      progress: { doneSteps: 1, totalSteps: 3 },
    }) as any;
    expect(running.aiHints[0]).toContain('Continue polling');

    const succeeded = enrichWithAiMarkdown('get_task_run', {
      runId: 'run_1',
      status: 'succeeded',
      artifactIds: ['artifact_1'],
      progress: { doneSteps: 3, totalSteps: 3 },
    }) as any;
    expect(succeeded.aiHints[0]).toContain('get_artifact');
    expect(succeeded.aiMarkdown).toContain('Artifact IDs: artifact_1');
  });

  it('adds continuation action for list_task_runs when hasMore is true', () => {
    const listRuns = enrichWithAiMarkdown('list_task_runs', {
      runs: [{ runId: 'run_latest' }],
      hasMore: true,
      nextCursor: { offset: 20, limit: 10 },
    }) as any;

    expect(Array.isArray(listRuns.nextActions)).toBe(true);
    expect(listRuns.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: 'list_task_runs', args: { offset: 20, limit: 10 } }),
      ]),
    );
  });

  it('normalizes nextActions with priority defaults and dedupe', () => {
    const enriched = enrichWithAiMarkdown('list_task_runs', {
      runs: [{ runId: 'run_latest' }],
      hasMore: true,
      nextCursor: { limit: 5, offset: 10 },
    }) as any;

    expect(Array.isArray(enriched.nextActions)).toBe(true);
    for (const action of enriched.nextActions) {
      expect(action.priority === 'high' || action.priority === 'medium' || action.priority === 'low').toBe(true);
      expect(typeof action.reason).toBe('string');
      expect(action.reason.length).toBeGreaterThan(0);
      expect(/[.!?]$/.test(action.reason)).toBe(true);
    }

    const cursorActions = enriched.nextActions.filter((a: any) => a.tool === 'list_task_runs');
    expect(cursorActions.length).toBe(1);
  });

  it('formats brief markdown with status-result-blocker order for high-frequency tools', () => {
    const previous = process.env.AI_MARKDOWN_DETAIL_LEVEL;
    process.env.AI_MARKDOWN_DETAIL_LEVEL = 'brief';

    try {
      const runStatus = enrichWithAiMarkdown('get_task_run', {
        runId: 'run_1',
        status: 'running',
        progress: { doneSteps: 1, totalSteps: 3 },
      }) as any;
      expect(runStatus.aiMarkdown).toContain('## Task Run Status');
      expect(runStatus.aiMarkdown).toContain('- Status:');
      expect(runStatus.aiMarkdown).toContain('- Result:');
      expect(runStatus.aiMarkdown).toContain('- Blocker:');

      const networkLogs = enrichWithAiMarkdown('get_network_logs', {
        logs: [{ status: 500, method: 'GET', url: 'https://example.com/api', resourceType: 'xhr' }],
        totalCount: 12,
        truncated: true,
        hasMore: true,
        nextCursor: { suggestedMaxEntries: 100 },
        topIssues: [{ kind: 'http_5xx', count: 1 }],
      }) as any;
      expect(networkLogs.aiMarkdown).toContain('## Network Logs');
      expect(networkLogs.aiMarkdown).toContain('- Status:');
      expect(networkLogs.aiMarkdown).toContain('- Result:');
      expect(networkLogs.aiMarkdown).toContain('- Blocker:');
      expect(networkLogs.aiMarkdown).not.toContain('| method | status |');
    } finally {
      if (previous === undefined) {
        delete process.env.AI_MARKDOWN_DETAIL_LEVEL;
      } else {
        process.env.AI_MARKDOWN_DETAIL_LEVEL = previous;
      }
    }
  });


  it('adds schemaRepairGuidance when verification fails', () => {
    const enriched = enrichWithAiMarkdown('get_task_run', {
      runId: 'run_schema_1',
      status: 'failed',
      verification: {
        pass: false,
        missingFields: ['companyName', 'taxId'],
        typeMismatches: ['amount'],
        reason: 'schema verification failed',
      },
      sessionId: 'sess_schema',
      artifactIds: ['artifact_schema_1'],
      schemaRepairHints: ['Missing fields: companyName, taxId'],
    }) as any;

    expect(enriched.aiSummary).toContain('schema gaps');
    expect(enriched.aiMarkdown).toContain('Verification: pass=false');
    expect(Array.isArray(enriched.schemaRepairGuidance?.recommendedChecks)).toBe(true);
    expect(enriched.schemaRepairGuidance?.missingFields).toEqual(['companyName', 'taxId']);
    expect(enriched.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: 'get_page_content' }),
      ]),
    );
  });

  it('adds deltaSummary for polling-oriented tools', () => {
    const runId = 'run_delta_case';

    const first = enrichWithAiMarkdown('get_task_run', {
      runId,
      status: 'running',
      progress: { doneSteps: 1, totalSteps: 3 },
      artifactIds: [],
    }) as any;
    expect(first.deltaSummary).toBeTruthy();
    expect(first.deltaSummary.key).toBe(`get_task_run:${runId}`);
    expect(first.deltaSummary.changes).toContain('initial snapshot');

    const second = enrichWithAiMarkdown('get_task_run', {
      runId,
      status: 'running',
      progress: { doneSteps: 2, totalSteps: 3 },
      artifactIds: [],
    }) as any;
    expect(second.deltaSummary.changes.join(' ')).toContain('progress changed');

    const third = enrichWithAiMarkdown('get_network_logs', {
      logs: [{ method: 'GET', status: 500, url: 'https://example.com/api', resourceType: 'xhr' }],
      totalCount: 1,
      truncated: false,
      topIssues: [{ kind: 'http_5xx', count: 1 }],
    }) as any;
    expect(third.deltaSummary).toBeTruthy();
    expect(third.deltaSummary.key).toBe('get_network_logs:default');
  });
});
