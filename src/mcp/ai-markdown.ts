type AnyRecord = Record<string, any>;

type DetailLevel = 'brief' | 'normal' | 'full';

interface AiNextAction {
  tool: string;
  args?: Record<string, unknown>;
  reason: string;
  priority?: 'high' | 'medium' | 'low';
}

const AI_SCHEMA_VERSION = '1.0';
const DETAIL_LEVEL_ENV = 'AI_MARKDOWN_DETAIL_LEVEL';
const ADAPTIVE_DETAIL_ENV = 'AI_MARKDOWN_ADAPTIVE_POLICY';
const DELTA_CACHE_LIMIT = 512;
const deltaSnapshotCache = new Map<string, AnyRecord>();

type DetailSource = 'data' | 'env' | 'default';
type DetailPolicyMode = 'fixed' | 'adaptive';

type DetailDecision = {
  level: DetailLevel;
  source: DetailSource;
  mode: DetailPolicyMode;
  reason: string;
};

type ToolName =
  | 'create_session'
  | 'close_session'
  | 'navigate'
  | 'get_page_info'
  | 'get_page_content'
  | 'find_element'
  | 'click'
  | 'type_text'
  | 'press_key'
  | 'wait'
  | 'wait_for_stable'
  | 'scroll'
  | 'go_back'
  | 'select_option'
  | 'hover'
  | 'set_value'
  | 'switch_tab'
  | 'close_tab'
  | 'create_tab'
  | 'list_tabs'
  | 'screenshot'
  | 'execute_javascript'
  | 'handle_dialog'
  | 'get_dialog_info'
  | 'get_network_logs'
  | 'get_console_logs'
  | 'upload_file'
  | 'get_downloads'
  | 'list_task_templates'
  | 'run_task_template'
  | 'get_task_run'
  | 'list_task_runs'
  | 'cancel_task_run'
  | 'get_artifact'
  | 'get_runtime_profile';

export function enrichWithAiMarkdown(toolName: string, data: unknown): unknown {
  if (!isObject(data)) return data;
  if (typeof data.aiMarkdown === 'string') return data;

  const normalizedTool = normalizeToolName(toolName);
  if (!normalizedTool) return data;

  const detailDecision = resolveDetailDecision(normalizedTool, data);
  const detailLevel = detailDecision.level;
  const dataWithDetail: AnyRecord = { ...data, aiDetailLevel: detailLevel };
  const aiMarkdown = buildAiMarkdown(normalizedTool, dataWithDetail);
  if (!aiMarkdown) return data;

  const aiSummary = buildAiSummary(normalizedTool, dataWithDetail);
  const aiHints = buildAiHints(normalizedTool, dataWithDetail);
  const nextActions = buildNextActions(normalizedTool, dataWithDetail, detailLevel);
  const deltaSummary = buildDeltaSummary(normalizedTool, dataWithDetail);
  const schemaRepairGuidance = buildSchemaRepairGuidance(normalizedTool, dataWithDetail);

  return {
    ...data,
    aiSchemaVersion: AI_SCHEMA_VERSION,
    aiDetailLevel: detailLevel,
    aiDetailPolicy: {
      mode: detailDecision.mode,
      source: detailDecision.source,
      reason: detailDecision.reason,
    },
    aiSummary,
    aiMarkdown,
    aiHints,
    nextActions,
    ...(deltaSummary ? { deltaSummary } : {}),
    ...(schemaRepairGuidance ? { schemaRepairGuidance } : {}),
  };
}

function normalizeToolName(toolName: string): ToolName | null {
  const direct: ToolName[] = [
    'create_session',
    'close_session',
    'navigate',
    'get_page_info',
    'get_page_content',
    'find_element',
    'click',
    'type_text',
    'press_key',
    'wait',
    'wait_for_stable',
    'scroll',
    'go_back',
    'select_option',
    'hover',
    'set_value',
    'switch_tab',
    'close_tab',
    'create_tab',
    'list_tabs',
    'screenshot',
    'execute_javascript',
    'handle_dialog',
    'get_dialog_info',
    'get_network_logs',
    'get_console_logs',
    'upload_file',
    'get_downloads',
    'list_task_templates',
    'run_task_template',
    'get_task_run',
    'list_task_runs',
    'cancel_task_run',
    'get_artifact',
    'get_runtime_profile',
  ];
  return direct.includes(toolName as ToolName) ? (toolName as ToolName) : null;
}

function buildAiMarkdown(toolName: ToolName, data: AnyRecord): string {
  switch (toolName) {
    case 'create_session':
      return formatCreateSession(data);
    case 'close_session':
      return formatCloseSession(data);
    case 'navigate':
      return formatNavigate(data);
    case 'get_page_info':
      return formatPageInfo(data);
    case 'get_page_content':
      return formatPageContent(data);
    case 'find_element':
      return formatFindElement(data);
    case 'click':
    case 'type_text':
    case 'press_key':
    case 'wait':
    case 'wait_for_stable':
    case 'scroll':
    case 'go_back':
    case 'select_option':
    case 'hover':
    case 'set_value':
    case 'switch_tab':
    case 'close_tab':
    case 'handle_dialog':
    case 'upload_file':
      return formatActionResult(toolName, data);
    case 'create_tab':
      return formatCreateTab(data);
    case 'list_tabs':
      return formatTabList(data);
    case 'screenshot':
      return formatScreenshotMeta(data);
    case 'execute_javascript':
      return formatExecuteJavascript(data);
    case 'get_dialog_info':
      return formatDialogInfo(data);
    case 'get_network_logs':
      return formatNetworkLogs(data);
    case 'get_console_logs':
      return formatConsoleLogs(data);
    case 'get_downloads':
      return formatDownloads(data);
    case 'list_task_templates':
      return formatTemplateList(data);
    case 'run_task_template':
      return formatRunSubmit(data);
    case 'get_task_run':
      return formatRunStatus(data);
    case 'list_task_runs':
      return formatRunList(data);
    case 'cancel_task_run':
      return formatCancelTaskRun(data);
    case 'get_artifact':
      return formatArtifact(data);
    case 'get_runtime_profile':
      return formatRuntimeProfile(data);
    default:
      return '';
  }
}

function buildAiSummary(toolName: ToolName, data: AnyRecord): string {
  switch (toolName) {
    case 'create_session':
      return `Session created: ${asString(data.sessionId) || 'unknown-session'}`;
    case 'close_session':
      return `Session close result: success=${boolText(data.success)}${data.kept ? ', kept=headful' : ''}`;
    case 'navigate': {
      const pageTitle = asString(data.page?.title) || 'Untitled';
      const pageUrl = asString(data.page?.url) || 'unknown-url';
      const partial = Boolean(data.partial);
      return partial
        ? `Navigation partially completed: ${pageTitle} (${pageUrl})`
        : `Navigation completed: ${pageTitle} (${pageUrl})`;
    }
    case 'get_page_info': {
      const count = Array.isArray(data.elements) ? data.elements.length : 0;
      const total = numberOrNull(data.totalElements);
      const title = asString(data.page?.title) || 'Untitled';
      if (typeof total === 'number') {
        return `Collected ${count}/${total} interactive elements from ${title}`;
      }
      return `Collected ${count} interactive elements from ${title}`;
    }
    case 'get_page_content': {
      const sections = Array.isArray(data.sections) ? data.sections.length : 0;
      const title = asString(data.title) || 'Page content';
      return `Extracted ${sections} content sections from ${title}`;
    }
    case 'find_element': {
      const candidates = Array.isArray(data.candidates) ? data.candidates.length : 0;
      return `Found ${candidates} candidates for query: ${asString(data.query) || '-'}`;
    }
    case 'click':
    case 'type_text':
    case 'press_key':
    case 'wait':
    case 'wait_for_stable':
    case 'scroll':
    case 'go_back':
    case 'select_option':
    case 'hover':
    case 'set_value':
    case 'switch_tab':
    case 'close_tab':
    case 'handle_dialog':
    case 'upload_file':
      return `${toolName} executed: success=${boolText(data.success)}`;
    case 'create_tab':
      return `Created tab: ${asString(data.tabId) || 'unknown-tab'}${data.partial ? ' (partial navigation)' : ''}`;
    case 'list_tabs': {
      const tabs = Array.isArray(data.tabs) ? data.tabs.length : 0;
      const active = asString(data.activeTabId) || 'unknown';
      return `Listed ${tabs} tabs (active: ${active})`;
    }
    case 'screenshot':
      return `Screenshot captured: ${asString(data.title) || asString(data.url) || 'current page'}`;
    case 'execute_javascript': {
      const truncated = Boolean(data.truncated);
      return truncated ? 'JavaScript executed (result truncated)' : 'JavaScript executed';
    }
    case 'get_dialog_info': {
      const pending = data.pendingDialog ? 'yes' : 'no';
      const history = Array.isArray(data.dialogHistory) ? data.dialogHistory.length : 0;
      return `Dialog status: pending=${pending}, history=${history}`;
    }
    case 'get_network_logs': {
      const count = Array.isArray(data.logs) ? data.logs.length : 0;
      const total = numberOrNull(data.totalCount);
      if (typeof total === 'number') return `Network logs: returned ${count}/${total}`;
      return `Network logs: returned ${count}`;
    }
    case 'get_console_logs': {
      const logs = Array.isArray(data.logs) ? data.logs : [];
      const errors = logs.filter((l: any) => asString(l?.level) === 'error').length;
      const warns = logs.filter((l: any) => asString(l?.level) === 'warn').length;
      return `Console logs: ${logs.length} entries (error=${errors}, warn=${warns})`;
    }
    case 'get_downloads': {
      const downloads = Array.isArray(data.downloads) ? data.downloads.length : 0;
      return `Downloads listed: ${downloads}`;
    }
    case 'list_task_templates': {
      const templates = Array.isArray(data.templates) ? data.templates.length : 0;
      return `Listed ${templates} task templates`;
    }
    case 'run_task_template':
      return `Task run submitted: ${asString(data.runId) || 'unknown-run'} (${asString(data.status) || 'unknown-status'})`;
    case 'get_task_run': {
      const verification = extractVerificationSnapshot(data);
      if (verification && !verification.pass) {
        const miss = verification.missingFields.length;
        const mismatch = verification.typeMismatches.length;
        return `Task run status: ${asString(data.runId) || 'unknown-run'} -> ${asString(data.status) || 'unknown-status'} (schema gaps: missing=${miss}, type=${mismatch})`;
      }
      return `Task run status: ${asString(data.runId) || 'unknown-run'} -> ${asString(data.status) || 'unknown-status'}`;
    }
    case 'list_task_runs': {
      const runs = Array.isArray(data.runs) ? data.runs.length : 0;
      return `Listed ${runs} task runs`;
    }
    case 'cancel_task_run':
      return `Cancel task result: success=${boolText(data.success)}`;
    case 'get_artifact':
      return `Artifact chunk: ${asString(data.artifactId) || 'unknown-artifact'} (${numberOrNull(data.length) ?? 0} bytes)`;
    case 'get_runtime_profile':
      return `Runtime profile: maxConcurrentRuns=${numberOrNull(data.maxConcurrentRuns) ?? '-'}, trustLevel=${asString(data.trustLevel) || '-'}`;
    default:
      return `${toolName} completed`;
  }
}

function buildAiHints(toolName: ToolName, data: AnyRecord): string[] {
  switch (toolName) {
    case 'create_session':
      return ['Use the returned sessionId for follow-up actions.'];
    case 'close_session':
      return data.kept
        ? ['Session is preserved because it is headful; set force=true if closure is required.']
        : ['Create a new session if more actions are needed.'];
    case 'navigate': {
      const hints = ['Call get_page_info next to discover actionable elements.'];
      if (Boolean(data.partial)) {
        hints.unshift('Page load was partial; consider wait_for_stable before interacting.');
      }
      return hints;
    }
    case 'get_page_info': {
      const hints = ['Use element IDs from the table for click/type_text operations.'];
      if (Boolean(data.truncated)) {
        hints.push('Results are truncated; rerun with a larger maxElements if needed.');
      }
      if (data.pendingDialog) {
        hints.push('A dialog is pending; use handle_dialog before further actions.');
      }
      return hints;
    }
    case 'get_page_content':
      return ['If key information is missing, scroll and call get_page_content again.'];
    case 'find_element':
      return ['Pick the highest score candidate first; fallback to next candidate on failure.'];
    case 'scroll':
      return ['After scrolling, call get_page_info or get_page_content to refresh visible information.'];
    case 'go_back':
      return ['Use get_page_info to inspect the previous page state after navigation.'];
    case 'select_option':
      return ['If selection has downstream effects, wait briefly and fetch updated page info.'];
    case 'hover':
      return ['Hover may reveal menus/tooltips; call get_page_info to capture newly visible controls.'];
    case 'set_value':
      return ['After setting value, submit form via press_key Enter or click the submit control.'];
    case 'switch_tab':
      return ['Continue operations in the active tab or list_tabs to confirm context.'];
    case 'close_tab':
      return ['Call list_tabs to verify remaining tabs and active context.'];
    case 'create_tab':
      return ['If partial=true, call wait_for_stable then inspect page info.'];
    case 'list_tabs':
      return ['Switch context with switch_tab before interacting with a non-active tab.'];
    case 'screenshot':
      return ['Use get_page_info/get_page_content for structured reasoning instead of image-only analysis.'];
    case 'execute_javascript':
      return ['Prefer deterministic return values; avoid relying on console.log output.'];
    case 'handle_dialog':
      return data.success
        ? ['Dialog handled; continue the original interaction flow.']
        : ['No dialog was handled; call get_dialog_info to inspect current dialog state.'];
    case 'get_dialog_info':
      return data.pendingDialog
        ? ['A dialog is pending; call handle_dialog before further page actions.']
        : ['No blocking dialog now; continue normal page interaction flow.'];
    case 'get_network_logs':
      return ['Use filter=failed or filter=slow to quickly isolate problematic requests.'];
    case 'get_console_logs':
      return ['Focus on error/warn entries first; rerun with level=all only if needed.'];
    case 'upload_file':
      return ['Call get_page_info to confirm upload-related UI state changes.'];
    case 'get_downloads':
      return ['Use the latest download entry to confirm completion or inspect error fields.'];
    case 'list_task_templates':
      return ['Pick a templateId and call run_task_template with validated inputs.'];
    case 'run_task_template':
      return ['Use get_task_run with runId to monitor progress until terminal status.'];
    case 'get_task_run': {
      const status = asString(data.status);
      const verification = extractVerificationSnapshot(data);
      if (verification && !verification.pass) {
        const hints: string[] = [];
        if (verification.missingFields.length > 0) {
          hints.push(`Schema missing fields: ${verification.missingFields.slice(0, 8).join(', ')}.`);
        }
        if (verification.typeMismatches.length > 0) {
          hints.push(`Schema type mismatches: ${verification.typeMismatches.slice(0, 8).join(', ')}.`);
        }
        hints.push('Collect stronger evidence before retrying; prioritize missing fields first.');
        return hints;
      }

      if (status === 'running' || status === 'queued') {
        return ['Continue polling get_task_run until terminal status.'];
      }
      if (status === 'succeeded' || status === 'partial_success') {
        return ['If artifactIds exist, call get_artifact to fetch evidence chunks.'];
      }
      return ['Check error details and adjust inputs before retrying.'];
    }
    case 'list_task_runs':
      return ['Select a runId and call get_task_run for full details.'];
    case 'cancel_task_run':
      return ['If cancellation fails due to terminal status, inspect run details with get_task_run.'];
    case 'get_artifact':
      return ['If complete=false, increase offset and call get_artifact again.'];
    case 'get_runtime_profile':
      return ['Use runtime limits to tune task batch size, mode, and polling strategy.'];
    default:
      return [];
  }
}


function resolveDetailDecision(toolName: ToolName, data?: AnyRecord): DetailDecision {
  const fromData = parseDetailLevel(data?.aiDetailLevel);
  if (fromData) {
    return {
      level: fromData,
      source: 'data',
      mode: 'fixed',
      reason: 'detail level explicitly provided in payload',
    };
  }

  const fromEnv = parseDetailLevel(process.env[DETAIL_LEVEL_ENV]);
  const baseLevel = fromEnv ?? 'normal';
  const source: DetailSource = fromEnv ? 'env' : 'default';

  if (!parseBooleanEnv(process.env[ADAPTIVE_DETAIL_ENV])) {
    return {
      level: baseLevel,
      source,
      mode: 'fixed',
      reason: source === 'env' ? 'detail level provided by environment' : 'default detail level',
    };
  }

  const adaptive = computeAdaptiveDetail(toolName, data, baseLevel);
  if (adaptive.level === baseLevel) {
    return {
      level: baseLevel,
      source,
      mode: 'fixed',
      reason: adaptive.reason,
    };
  }

  return {
    level: adaptive.level,
    source,
    mode: 'adaptive',
    reason: adaptive.reason,
  };
}

function resolveDetailLevel(data?: AnyRecord): DetailLevel {
  const fromData = parseDetailLevel(data?.aiDetailLevel);
  if (fromData) return fromData;
  const fromEnv = parseDetailLevel(process.env[DETAIL_LEVEL_ENV]);
  return fromEnv ?? 'normal';
}

function computeAdaptiveDetail(toolName: ToolName, data: AnyRecord | undefined, baseLevel: DetailLevel): { level: DetailLevel; reason: string } {
  if (baseLevel === 'full') {
    return { level: baseLevel, reason: 'adaptive policy keeps full detail unchanged' };
  }

  const status = asString(data?.status);

  switch (toolName) {
    case 'get_task_run':
      if (status === 'queued' || status === 'running') {
        return { level: 'brief', reason: 'adaptive policy: non-terminal task polling prefers brief detail' };
      }
      if (status === 'failed' || status === 'canceled') {
        return { level: 'full', reason: 'adaptive policy: terminal failure escalates detail for debugging' };
      }
      return { level: baseLevel, reason: 'adaptive policy: keep base detail for terminal success states' };
    case 'list_task_runs':
      if (Boolean(data?.hasMore)) {
        return { level: 'brief', reason: 'adaptive policy: paginated run listing prefers concise summary' };
      }
      return { level: baseLevel, reason: 'adaptive policy: keep base detail for short run lists' };
    case 'get_network_logs':
    case 'get_console_logs':
      if (Boolean(data?.hasMore) || Boolean(data?.truncated)) {
        return { level: 'brief', reason: 'adaptive policy: log polling prefers concise change-focused output' };
      }
      return { level: baseLevel, reason: 'adaptive policy: keep base detail for complete log snapshots' };
    case 'get_downloads': {
      const downloads = Array.isArray(data?.downloads) ? data?.downloads : [];
      const hasPending = downloads.some((item: AnyRecord) => item && item.completed === false);
      if (hasPending) {
        return { level: 'brief', reason: 'adaptive policy: pending downloads prefer concise polling output' };
      }
      return { level: baseLevel, reason: 'adaptive policy: keep base detail for stable download lists' };
    }
    case 'get_artifact':
      if (data?.complete === false) {
        return { level: 'brief', reason: 'adaptive policy: chunked artifact retrieval prefers concise continuation guidance' };
      }
      return { level: baseLevel, reason: 'adaptive policy: keep base detail for completed artifact payloads' };
    default:
      return { level: baseLevel, reason: 'adaptive policy: tool not in adaptive set, keep base detail' };
  }
}

function parseDetailLevel(value: unknown): DetailLevel | null {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase();
  if (normalized === 'brief' || normalized === 'normal' || normalized === 'full') {
    return normalized;
  }
  return null;
}

function parseBooleanEnv(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function pickByDetail(detail: DetailLevel, limits: { brief: number; normal: number; full: number }): number {
  if (detail === 'brief') return limits.brief;
  if (detail === 'full') return limits.full;
  return limits.normal;
}

function buildNextActions(toolName: ToolName, data: AnyRecord, detailLevel: DetailLevel): AiNextAction[] {
  const actions: AiNextAction[] = [];

  const add = (action: AiNextAction) => {
    actions.push(action);
  };

  switch (toolName) {
    case 'create_session':
      add({ tool: 'navigate', reason: 'Open target page after creating session', priority: 'high' });
      break;
    case 'navigate':
      add({ tool: 'get_page_info', reason: 'Inspect actionable elements on the loaded page', priority: 'high' });
      if (Boolean(data.partial)) {
        add({ tool: 'wait_for_stable', reason: 'Page load is partial, wait for stability first', priority: 'high' });
      }
      break;
    case 'get_page_info': {
      const recommendations = collectIntentRecommendations(data);
      if (recommendations.length > 0) {
        const first = recommendations[0];
        add({
          tool: 'click',
          args: { element_id: first.suggestedElementIds[0] },
          reason: `Try intent '${first.intent}' using recommended element`,
          priority: 'high',
        });
      }
      add({ tool: 'find_element', reason: 'Use semantic fallback if target control is still unclear', priority: 'medium' });
      if (Boolean(data.truncated)) {
        add({ tool: 'get_page_info', args: { maxElements: Math.max(numberOrNull(data.elements?.length) ?? 50, 100) }, reason: 'Increase maxElements to inspect more controls', priority: 'medium' });
      }
      break;
    }
    case 'find_element': {
      const first = Array.isArray(data.candidates) ? data.candidates[0] : null;
      if (first?.id) {
        const candidateId = asString(first.id);
        add({ tool: 'click', args: { element_id: candidateId }, reason: 'Try top-ranked candidate', priority: 'high' });
        add({ tool: 'type_text', args: { element_id: candidateId, text: '<value>' }, reason: 'If candidate is an input, provide value via type_text', priority: 'medium' });
      }
      break;
    }
    case 'list_tabs': {
      const active = asString(data.activeTabId);
      const tabs = Array.isArray(data.tabs) ? data.tabs : [];
      const alternative = tabs.find((t: any) => asString(t?.id) && asString(t?.id) !== active);
      if (alternative?.id) {
        add({ tool: 'switch_tab', args: { tabId: asString(alternative.id) }, reason: 'Switch to a non-active tab for further actions', priority: 'high' });
      }
      break;
    }
    case 'get_dialog_info':
      if (data.pendingDialog) {
        add({ tool: 'handle_dialog', args: { action: 'accept' }, reason: 'Resolve pending dialog before other actions', priority: 'high' });
      }
      break;
    case 'get_network_logs': {
      const cursor = asCursor(data.nextCursor);
      const cursorArgs = buildMaxEntriesCursorArgs(cursor);
      if (Boolean(data.hasMore) && cursorArgs) {
        add({ tool: 'get_network_logs', args: cursorArgs, reason: 'Continue retrieving older network logs', priority: 'high' });
      }
      add({ tool: 'get_network_logs', args: { filter: 'failed' }, reason: 'Focus on failed requests first', priority: 'medium' });
      break;
    }
    case 'get_console_logs': {
      const cursor = asCursor(data.nextCursor);
      const cursorArgs = buildMaxEntriesCursorArgs(cursor);
      if (Boolean(data.hasMore) && cursorArgs) {
        add({ tool: 'get_console_logs', args: cursorArgs, reason: 'Continue retrieving older console logs', priority: 'high' });
      }
      add({ tool: 'get_console_logs', args: { level: 'all' }, reason: 'Expand log level only if needed after error/warn analysis', priority: 'medium' });
      break;
    }
    case 'get_downloads': {
      const downloads = Array.isArray(data.downloads) ? data.downloads : [];
      const pending = downloads.find((d: any) => d && d.completed === false);
      if (pending) {
        add({ tool: 'wait', args: { milliseconds: 1000 }, reason: 'Wait for pending download completion', priority: 'medium' });
      }
      break;
    }
    case 'run_task_template':
      add({ tool: 'get_task_run', args: { runId: asString(data.runId) || '<runId>' }, reason: 'Poll task run status until terminal state', priority: 'high' });
      break;
    case 'get_task_run': {
      const status = asString(data.status);
      const verification = extractVerificationSnapshot(data);
      const sessionId = asString(data.sessionId);

      if (status === 'queued' || status === 'running') {
        add({ tool: 'get_task_run', args: { runId: asString(data.runId) || '<runId>' }, reason: 'Continue polling until completion', priority: 'high' });
      } else if (Array.isArray(data.artifactIds) && data.artifactIds.length > 0) {
        add({ tool: 'get_artifact', args: { artifactId: asString(data.artifactIds[0]) }, reason: 'Fetch first evidence artifact', priority: 'high' });
      }

      if (verification && !verification.pass) {
        if (verification.missingFields.length > 0 && sessionId) {
          add({ tool: 'get_page_content', args: { sessionId }, reason: 'Collect richer textual evidence for schema-missing fields', priority: 'high' });
        }
        if (verification.typeMismatches.length > 0 && sessionId) {
          add({ tool: 'get_page_info', args: { sessionId, maxElements: 120 }, reason: 'Collect structured element state to repair type mismatches', priority: 'medium' });
        }
      }
      break;
    }
    case 'list_task_runs': {
      const runs = Array.isArray(data.runs) ? data.runs : [];
      const first = runs[0];
      if (first?.runId) {
        add({ tool: 'get_task_run', args: { runId: asString(first.runId) }, reason: 'Open latest run details', priority: 'high' });
      }
      const cursor = asCursor(data.nextCursor);
      const cursorArgs = buildListRunsCursorArgs(cursor);
      if (Boolean(data.hasMore) && cursorArgs) {
        add({ tool: 'list_task_runs', args: cursorArgs, reason: 'Continue listing older runs with nextCursor', priority: 'medium' });
      }
      break;
    }
    case 'get_artifact':
      if (!Boolean(data.complete)) {
        add({
          tool: 'get_artifact',
          args: { artifactId: asString(data.artifactId), offset: (numberOrNull(data.offset) ?? 0) + (numberOrNull(data.length) ?? 0) },
          reason: 'Continue fetching remaining artifact chunks',
          priority: 'high',
        });
      }
      break;
    default:
      break;
  }

  return finalizeNextActions(actions, detailLevel);
}

type VerificationSnapshot = {
  pass: boolean;
  score?: number;
  missingFields: string[];
  typeMismatches: string[];
  reason?: string;
};

type SchemaRepairGuidance = {
  status: 'schema_failed';
  missingFields: string[];
  typeMismatches: string[];
  recommendedChecks: string[];
  retryAdvice: string;
};

function extractVerificationSnapshot(data: AnyRecord): VerificationSnapshot | null {
  const direct = normalizeVerification(data?.verification);
  if (direct) return direct;
  const nested = normalizeVerification(data?.result?.verification);
  if (nested) return nested;
  return null;
}

function normalizeVerification(value: unknown): VerificationSnapshot | null {
  if (!isObject(value)) return null;
  if (typeof value.pass !== 'boolean') return null;

  return {
    pass: value.pass,
    score: typeof value.score === 'number' ? value.score : undefined,
    missingFields: Array.isArray(value.missingFields)
      ? value.missingFields.map((item: unknown) => asString(item) || String(item)).filter(Boolean)
      : [],
    typeMismatches: Array.isArray(value.typeMismatches)
      ? value.typeMismatches.map((item: unknown) => asString(item) || String(item)).filter(Boolean)
      : [],
    reason: typeof value.reason === 'string' ? value.reason : undefined,
  };
}

function buildSchemaRepairGuidance(toolName: ToolName, data: AnyRecord): SchemaRepairGuidance | null {
  if (toolName !== 'get_task_run') return null;

  const verification = extractVerificationSnapshot(data);
  if (!verification || verification.pass) return null;

  const recommendedChecks: string[] = [];
  if (verification.missingFields.length > 0) {
    recommendedChecks.push(`Re-collect fields: ${verification.missingFields.slice(0, 8).join(', ')}`);
  }
  if (verification.typeMismatches.length > 0) {
    recommendedChecks.push(`Normalize value types for: ${verification.typeMismatches.slice(0, 8).join(', ')}`);
  }
  if (Array.isArray(data.schemaRepairHints) && data.schemaRepairHints.length > 0) {
    recommendedChecks.push(...data.schemaRepairHints.slice(0, 4).map((item: unknown) => singleLine(String(item))));
  }

  return {
    status: 'schema_failed',
    missingFields: verification.missingFields,
    typeMismatches: verification.typeMismatches,
    recommendedChecks: recommendedChecks.slice(0, 8),
    retryAdvice: 'Retry only after collecting evidence for missing/type-mismatched fields.',
  };
}

function collectIntentRecommendations(data: AnyRecord): Array<{ intent: string; suggestedElementIds: string[] }> {
  const raw = Array.isArray(data.recommendedByIntent) ? data.recommendedByIntent : [];
  return raw
    .map((item: any) => ({
      intent: asString(item?.intent),
      suggestedElementIds: Array.isArray(item?.suggestedElementIds)
        ? item.suggestedElementIds.map((id: unknown) => asString(id)).filter(Boolean)
        : [],
    }))
    .filter((item: { intent: string; suggestedElementIds: string[] }) => item.intent && item.suggestedElementIds.length > 0);
}


function finalizeNextActions(actions: AiNextAction[], detailLevel: DetailLevel): AiNextAction[] {
  const normalized: AiNextAction[] = [];
  const seen = new Set<string>();

  for (const action of actions) {
    const normalizedAction = normalizeNextAction(action);
    if (!normalizedAction) continue;

    const dedupeKey = `${normalizedAction.tool}:${stableJson(normalizedAction.args ?? {})}`;
    if (seen.has(dedupeKey)) continue;

    seen.add(dedupeKey);
    normalized.push(normalizedAction);
  }

  const maxActions = pickByDetail(detailLevel, { brief: 1, normal: 3, full: 5 });
  return normalized.slice(0, maxActions);
}

function normalizeNextAction(action: AiNextAction): AiNextAction | null {
  const tool = singleLine(asString(action.tool));
  const reasonRaw = singleLine(asString(action.reason));
  if (!tool || !reasonRaw) return null;

  const args = isObject(action.args) ? sanitizeActionArgs(action.args) : undefined;
  const priority = normalizePriority(action.priority);
  const reason = normalizeReason(reasonRaw);

  return {
    tool,
    ...(args ? { args } : {}),
    reason,
    priority,
  };
}

function sanitizeActionArgs(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(args).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

function normalizePriority(priority: AiNextAction['priority'] | undefined): 'high' | 'medium' | 'low' {
  if (priority === 'high' || priority === 'medium' || priority === 'low') return priority;
  return 'medium';
}

function normalizeReason(reason: string): string {
  const compact = compactText(reason, 140);
  return /[.!?]$/.test(compact) ? compact : `${compact}.`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as AnyRecord)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}


function formatBriefStatusResultBlock(options: {
  title: string;
  status: string;
  result: string;
  blocker?: string;
  next: string;
}): string {
  const blocker = options.blocker && options.blocker.trim().length > 0 ? options.blocker : 'none';
  return [
    `## ${options.title}`,
    '',
    `- Status: ${options.status}`,
    `- Result: ${options.result}`,
    `- Blocker: ${blocker}`,
    '',
    '### Recommended Next Step',
    '',
    `- ${options.next}`,
  ].join('\n');
}



function buildDeltaSummary(toolName: ToolName, data: AnyRecord): { key: string; changes: string[] } | null {
  switch (toolName) {
    case 'get_task_run': {
      const runId = asString(data.runId);
      if (!runId) return null;
      const key = `get_task_run:${runId}`;
      const snapshot: AnyRecord = {
        status: asString(data.status) || '-',
        doneSteps: asNumber(data.progress?.doneSteps),
        totalSteps: asNumber(data.progress?.totalSteps),
        artifactCount: Array.isArray(data.artifactIds) ? data.artifactIds.length : 0,
      };
      const changes = diffSnapshots(deltaSnapshotCache.get(key), snapshot, {
        status: (prev, next) => `status changed: ${prev} -> ${next}`,
        doneSteps: (prev, next, curr) => {
          const prevText = `${prev ?? 0}/${curr.totalSteps ?? '-'}`;
          const nextText = `${next ?? 0}/${curr.totalSteps ?? '-'}`;
          return `progress changed: ${prevText} -> ${nextText}`;
        },
        totalSteps: (_prev, next, curr) => `progress denominator now: ${curr.doneSteps ?? 0}/${next ?? '-'}`,
        artifactCount: (prev, next) => `artifact count changed: ${prev ?? 0} -> ${next ?? 0}`,
      });
      putDeltaSnapshot(key, snapshot);
      return { key, changes };
    }
    case 'list_task_runs': {
      const first = Array.isArray(data.runs) && data.runs.length > 0 ? data.runs[0] : null;
      const key = 'list_task_runs:default';
      const snapshot: AnyRecord = {
        firstRunId: asString(first?.runId) || '-',
        firstStatus: asString(first?.status) || '-',
        count: Array.isArray(data.runs) ? data.runs.length : 0,
        hasMore: Boolean(data.hasMore),
      };
      const changes = diffSnapshots(deltaSnapshotCache.get(key), snapshot, {
        firstRunId: (prev, next) => `latest run changed: ${prev} -> ${next}`,
        firstStatus: (prev, next) => `latest run status changed: ${prev} -> ${next}`,
        count: (prev, next) => `run count changed: ${prev ?? 0} -> ${next ?? 0}`,
        hasMore: (_prev, next) => `hasMore is now ${boolText(next)}`,
      });
      putDeltaSnapshot(key, snapshot);
      return { key, changes };
    }
    case 'get_network_logs':
    case 'get_console_logs': {
      const key = `${toolName}:default`;
      const snapshot: AnyRecord = {
        returned: Array.isArray(data.logs) ? data.logs.length : 0,
        truncated: Boolean(data.truncated),
        topIssue: Array.isArray(data.topIssues) && data.topIssues.length > 0
          ? `${asString(data.topIssues[0]?.kind)}:${numberOrNull(data.topIssues[0]?.count) ?? 0}`
          : '-',
      };
      const changes = diffSnapshots(deltaSnapshotCache.get(key), snapshot, {
        returned: (prev, next) => `returned entries changed: ${prev ?? 0} -> ${next ?? 0}`,
        truncated: (_prev, next) => `truncated is now ${boolText(next)}`,
        topIssue: (prev, next) => `top issue changed: ${prev} -> ${next}`,
      });
      putDeltaSnapshot(key, snapshot);
      return { key, changes };
    }
    default:
      return null;
  }
}

function diffSnapshots(
  previous: AnyRecord | undefined,
  current: AnyRecord,
  formatters: Record<string, (prev: unknown, next: unknown, current: AnyRecord) => string>,
): string[] {
  if (!previous) {
    return ['initial snapshot'];
  }

  const changes: string[] = [];
  for (const [field, formatter] of Object.entries(formatters)) {
    const prev = previous[field];
    const next = current[field];
    if (stableJson(prev) === stableJson(next)) continue;
    changes.push(formatter(prev, next, current));
  }

  return changes.length > 0 ? changes : ['no significant change'];
}

function putDeltaSnapshot(key: string, snapshot: AnyRecord): void {
  if (deltaSnapshotCache.has(key)) {
    deltaSnapshotCache.delete(key);
  }
  deltaSnapshotCache.set(key, snapshot);
  if (deltaSnapshotCache.size <= DELTA_CACHE_LIMIT) return;
  const oldestKey = deltaSnapshotCache.keys().next().value;
  if (oldestKey) {
    deltaSnapshotCache.delete(oldestKey);
  }
}

function formatCreateSession(data: AnyRecord): string {
  const lines = [
    '## Session Created',
    '',
    `- Session ID: ${asString(data.sessionId) || '-'}`,
    '',
    '### Recommended Next Step',
    '',
    '- Use this `sessionId` in subsequent tool calls.',
  ];
  return lines.join('\n');
}

function formatCloseSession(data: AnyRecord): string {
  const lines = [
    '## Session Close Result',
    '',
    `- Success: ${boolText(data.success)}`,
  ];

  if (typeof data.kept === 'boolean') {
    lines.push(`- Kept: ${boolText(data.kept)}`);
  }
  if (data.reason) {
    lines.push(`- Reason: ${singleLine(asString(data.reason) || '')}`);
  }

  lines.push('', '### Recommended Next Step', '');
  if (data.kept) {
    lines.push('- Session is still active; set `force=true` to close headful sessions.');
  } else {
    lines.push('- Create a new session when further browser actions are required.');
  }

  return lines.join('\n');
}

function formatCreateTab(data: AnyRecord): string {
  const lines = [
    '## Tab Created',
    '',
    `- Success: ${boolText(Boolean(data.tabId) || data.success)}`,
    `- Tab ID: ${asString(data.tabId) || '-'}`,
    `- URL: ${asString(data.url) || '-'}`,
    `- Partial Navigation: ${boolText(data.partial)}`,
    '',
    '### Recommended Next Step',
    '',
    '- Call `get_page_info` in the new active tab before interaction.',
  ];
  return lines.join('\n');
}


function formatScreenshotMeta(data: AnyRecord): string {
  const lines = [
    '## Screenshot Captured',
    '',
    `- Captured: ${boolText(data.captured)}`,
    `- URL: ${asString(data.url) || '-'}`,
    `- Title: ${asString(data.title) || '-'}`,
    `- Full Page: ${boolText(data.fullPage)}`,
    `- Element Target: ${asString(data.element) || '-'}`,
    '',
    '### Recommended Next Step',
    '',
    '- Use `get_page_info` / `get_page_content` to extract structured information.',
  ];
  return lines.join('\n');
}

function formatExecuteJavascript(data: AnyRecord): string {
  const resultPreview = compactText(singleLine(toDisplayText(data.result)), 220);
  const lines = [
    '## JavaScript Execution Result',
    '',
    `- Truncated: ${boolText(data.truncated)}`,
    `- Result Preview: ${resultPreview || '-'}`,
  ];

  if (data.hint) {
    lines.push(`- Hint: ${singleLine(asString(data.hint) || '')}`);
  }

  lines.push('', '### Recommended Next Step', '', '- Return structured values (object/array) for easier downstream parsing.');
  return lines.join('\n');
}

function formatDownloads(data: AnyRecord): string {
  const detail = resolveDetailLevel(data);
  const downloads = Array.isArray(data.downloads) ? data.downloads : [];
  const top = downloads.slice(0, pickByDetail(detail, { brief: 10, normal: 20, full: 40 }));

  const lines = [
    '## Downloads',
    '',
    `- Returned Downloads: ${downloads.length}`,
    '',
    '| id | filename | completed | size | error |',
    '|---|---|---|---:|---|',
  ];

  if (top.length === 0) {
    lines.push('| - | - | - | - | No downloads |');
  } else {
    for (const item of top) {
      lines.push(`| ${tableSafe(asString(item?.id) || '-')} | ${tableSafe(compactText(asString(item?.filename) || '-', 80))} | ${boolText(item?.completed)} | ${numberOrNull(item?.size) ?? '-'} | ${tableSafe(compactText(asString(item?.error) || '-', 60))} |`);
    }
  }

  lines.push('', '### Recommended Next Step', '', '- Use `completed=true` entries first for downstream file processing.');
  return lines.join('\n');
}

function formatTemplateList(data: AnyRecord): string {
  const detail = resolveDetailLevel(data);
  const templates = Array.isArray(data.templates) ? data.templates : [];
  const top = templates.slice(0, pickByDetail(detail, { brief: 10, normal: 20, full: 40 }));

  const lines = [
    '## Task Template List',
    '',
    `- Returned Templates: ${templates.length}`,
    '',
    '| templateId | version | mode | trust levels |',
    '|---|---|---|---|',
  ];

  if (top.length === 0) {
    lines.push('| - | - | - | - |');
  } else {
    for (const tpl of top) {
      const trust = Array.isArray(tpl?.trustLevelSupport) ? tpl.trustLevelSupport.join(', ') : '-';
      lines.push(`| ${tableSafe(asString(tpl?.templateId) || '-')} | ${tableSafe(asString(tpl?.version) || '-')} | ${tableSafe(asString(tpl?.executionMode) || '-')} | ${tableSafe(trust)} |`);
    }
  }

  lines.push('', '### Recommended Next Step', '', '- Select a `templateId` and validate required inputs before execution.');
  return lines.join('\n');
}

function formatCancelTaskRun(data: AnyRecord): string {
  const lines = [
    '## Cancel Task Run',
    '',
    `- Success: ${boolText(data.success)}`,
    `- Run ID: ${asString(data.runId) || '-'}`,
  ];

  if (data.reason) {
    lines.push(`- Reason: ${singleLine(asString(data.reason) || '')}`);
  }

  lines.push('', '### Recommended Next Step', '', '- Call `get_task_run` to confirm latest status.');
  return lines.join('\n');
}

function formatRuntimeProfile(data: AnyRecord): string {
  const lines = [
    '## Runtime Profile',
    '',
    `- maxConcurrentRuns: ${numberOrNull(data.maxConcurrentRuns) ?? '-'}`,
    `- maxUrls: ${numberOrNull(data.maxUrls) ?? '-'}`,
    `- maxTabsPerSession: ${numberOrNull(data.maxTabsPerSession) ?? '-'}`,
    `- syncTimeoutMs: ${numberOrNull(data.syncTimeoutMs) ?? '-'}`,
    `- asyncTimeoutMs: ${numberOrNull(data.asyncTimeoutMs) ?? '-'}`,
    `- artifactMaxChunkSize: ${numberOrNull(data.artifactMaxChunkSize) ?? '-'}`,
    `- artifactTtlMs: ${numberOrNull(data.artifactTtlMs) ?? '-'}`,
    `- runTtlMs: ${numberOrNull(data.runTtlMs) ?? '-'}`,
    `- trustLevel: ${asString(data.trustLevel) || '-'}`,
  ];

  if (Array.isArray(data.supportedModes) && data.supportedModes.length > 0) {
    lines.push(`- supportedModes: ${data.supportedModes.join(', ')}`);
  }

  lines.push('', '### Recommended Next Step', '', '- Adjust batch size/mode to stay within runtime limits.');
  return lines.join('\n');
}

function formatNavigate(data: AnyRecord): string {
  const lines = [
    '## Navigation Result',
    '',
    `- Success: ${boolText(data.success)}`,
    `- Partial: ${boolText(data.partial)}`,
    `- URL: ${asString(data.page?.url) || '-'}`,
    `- Title: ${asString(data.page?.title) || '-'}`,
  ];

  if (typeof data.statusCode === 'number') {
    lines.push(`- HTTP Status: ${data.statusCode}`);
  }

  if (data.dialog) {
    lines.push(`- Pending Dialog: ${asString(data.dialog.type) || 'yes'}`);
  }

  lines.push('', '### Recommended Next Step', '', '- Call `get_page_info` to identify actionable elements.');
  return lines.join('\n');
}

function formatPageInfo(data: AnyRecord): string {
  const detail = resolveDetailLevel(data);
  const elements = Array.isArray(data.elements) ? data.elements : [];
  const topElements = elements.slice(0, pickByDetail(detail, { brief: 10, normal: 20, full: 40 }));
  const intents = Array.isArray(data.intents) ? data.intents.slice(0, 6) : [];

  if (detail === 'brief') {
    const recommended = collectIntentRecommendations(data);
    const topIds = topElements.slice(0, 5).map((item) => asString(item?.id)).filter(Boolean);
    const blocker = data.pendingDialog
      ? `pending dialog ${asString(data.pendingDialog.type) || 'unknown'}`
      : (Boolean(data.truncated) ? 'element list truncated' : 'none');
    const resultParts = [
      `elements=${elements.length}`,
      topIds.length > 0 ? `topIds=${topIds.join(', ')}` : 'topIds=-',
      recommended.length > 0 ? `intent=${recommended[0].intent}` : null,
    ].filter(Boolean);

    return formatBriefStatusResultBlock({
      title: 'Page Interaction Snapshot',
      status: `${asString(data.page?.type) || 'unknown'} @ ${asString(data.page?.title) || '-'}`,
      result: resultParts.join('; '),
      blocker,
      next: data.pendingDialog ? 'Call `handle_dialog` before interacting with page elements.' : 'Use `click` / `type_text` with top element IDs.',
    });
  }

  const lines: string[] = [
    '## Page Interaction Snapshot',
    '',
    `- URL: ${asString(data.page?.url) || '-'}`,
    `- Title: ${asString(data.page?.title) || '-'}`,
    `- Page Type: ${asString(data.page?.type) || '-'}`,
    `- Summary: ${singleLine(asString(data.page?.summary) || '-')}`,
    `- Elements Returned: ${elements.length}`,
  ];

  if (typeof data.totalElements === 'number') {
    lines.push(`- Total Elements (before truncation): ${data.totalElements}`);
  }
  if (typeof data.truncated === 'boolean') {
    lines.push(`- Truncated: ${boolText(data.truncated)}`);
  }

  if (intents.length > 0) {
    lines.push(`- Detected Intents: ${intents.map((v: any) => singleLine(String(v))).join(', ')}`);
  }

  const recommended = collectIntentRecommendations(data);
  if (recommended.length > 0) {
    const compact = recommended
      .map((entry) => `${entry.intent}: ${entry.suggestedElementIds.slice(0, 3).join(', ')}`)
      .join(' ; ');
    lines.push(`- Recommended By Intent: ${compact || '-'}`);
  }

  if (data.stability) {
    lines.push(`- Stability: load=${asString(data.stability.loadState) || '-'}, networkPending=${numberOrNull(data.stability.networkPending) ?? '-'}`);
  }

  if (data.pendingDialog) {
    lines.push(`- Pending Dialog: ${asString(data.pendingDialog.type) || 'yes'}`);
  }

  lines.push('', '### Top Actionable Elements', '', '| id | type | label | state |', '|---|---|---|---|');
  if (topElements.length === 0) {
    lines.push('| - | - | No actionable elements detected | - |');
  } else {
    for (const el of topElements) {
      const id = tableSafe(asString(el?.id) || '-');
      const type = tableSafe(asString(el?.type) || '-');
      const label = tableSafe(compactText(asString(el?.label) || '-', 80));
      const state = tableSafe(compactState(el?.state));
      lines.push(`| \`${id}\` | ${type} | ${label} | ${state} |`);
    }
  }

  lines.push('', '### Recommended Next Step', '', '- Use `click` / `type_text` with element IDs from the table.');
  if (Boolean(data.pendingDialog)) {
    lines.push('- Handle the dialog first with `handle_dialog`.');
  }
  if (Boolean(data.truncated)) {
    lines.push('- Re-run with larger `maxElements` if needed.');
  }

  return lines.join('\n');
}

function formatPageContent(data: AnyRecord): string {
  const detail = resolveDetailLevel(data);
  const sections = Array.isArray(data.sections) ? data.sections : [];
  const topSections = sections.slice(0, pickByDetail(detail, { brief: 6, normal: 12, full: 24 }));

  if (detail === 'brief') {
    const topSnippet = topSections.slice(0, 2).map((section) => compactText(asString(section?.text) || '-', 80)).join(' | ');
    return formatBriefStatusResultBlock({
      title: 'Page Content Snapshot',
      status: `sections=${sections.length}`,
      result: topSnippet || 'no text extracted',
      blocker: sections.length === 0 ? 'no content extracted' : 'none',
      next: 'If required fields are missing, scroll and call `get_page_content` again.',
    });
  }

  const lines = [
    '## Page Content Snapshot',
    '',
    `- Title: ${asString(data.title) || '-'}`,
    `- URL: ${asString(data.url) || '-'}`,
    `- Sections: ${sections.length}`,
    '',
    '### Key Text Blocks',
    '',
  ];

  if (topSections.length === 0) {
    lines.push('- No sections extracted. Consider scrolling or using execute_javascript as fallback.');
  } else {
    for (const section of topSections) {
      const attention = numberOrNull(section?.attention);
      const level = typeof attention === 'number' ? `[attention=${attention.toFixed(2)}]` : '[attention=-]';
      lines.push(`- ${level} ${compactText(asString(section?.text) || '-', 240)}`);
    }
  }

  lines.push('', '### Recommended Next Step', '', '- If required fields are missing, scroll and call `get_page_content` again.');
  return lines.join('\n');
}

function formatFindElement(data: AnyRecord): string {
  const detail = resolveDetailLevel(data);
  const candidates = Array.isArray(data.candidates) ? data.candidates.slice(0, pickByDetail(detail, { brief: 5, normal: 10, full: 20 })) : [];
  const lines = [
    '## Element Search Result',
    '',
    `- Query: ${asString(data.query) || '-'}`,
    `- Candidates: ${Array.isArray(data.candidates) ? data.candidates.length : 0}`,
    '',
    '| rank | id | label | score | reason |',
    '|---:|---|---|---:|---|',
  ];

  if (candidates.length === 0) {
    lines.push('| 1 | - | No matches | 0 | - |');
  } else {
    candidates.forEach((c, index) => {
      lines.push(`| ${index + 1} | \`${tableSafe(asString(c.id) || '-')}\` | ${tableSafe(compactText(asString(c.label) || '-', 70))} | ${numberText(c.score)} | ${tableSafe(compactText(asString(c.matchReason) || '-', 60))} |`);
    });
  }

  lines.push('', '### Recommended Next Step', '', '- Try the highest-score candidate first with `click` or `type_text`.');
  return lines.join('\n');
}

function formatActionResult(toolName: ToolName, data: AnyRecord): string {
  const titleMap: Record<string, string> = {
    click: 'Click Result',
    type_text: 'Type Text Result',
    press_key: 'Press Key Result',
    wait: 'Wait Result',
    wait_for_stable: 'Stability Result',
    scroll: 'Scroll Result',
    go_back: 'Back Navigation Result',
    select_option: 'Select Option Result',
    hover: 'Hover Result',
    set_value: 'Set Value Result',
    switch_tab: 'Switch Tab Result',
    close_tab: 'Close Tab Result',
    handle_dialog: 'Handle Dialog Result',
    upload_file: 'Upload File Result',
  };

  const lines = [
    `## ${titleMap[toolName] || 'Action Result'}`,
    '',
    `- Success: ${boolText(data.success)}`,
  ];

  if (data.page) {
    lines.push(`- URL: ${asString(data.page.url) || '-'}`);
    lines.push(`- Title: ${asString(data.page.title) || '-'}`);
  }
  if (toolName === 'wait_for_stable') {
    lines.push(`- Stable: ${boolText(data.stable)}`);
    lines.push(`- DOM Stable: ${boolText(data.domStable)}`);
    lines.push(`- Network Pending: ${numberOrNull(data.networkPending) ?? '-'}`);
  }
  if (data.newTabCreated) {
    lines.push(`- New Tab Created: ${asString(data.newTabCreated)}`);
  }
  if (data.dialog) {
    lines.push(`- Dialog Type: ${asString(data.dialog.type) || 'yes'}`);
    if (asString(data.dialog.message)) {
      lines.push(`- Dialog Message: ${compactText(asString(data.dialog.message), 180)}`);
    }
  }
  if (data.filePath) {
    lines.push(`- File Path: ${asString(data.filePath)}`);
  }
  if (data.reason) {
    lines.push(`- Reason: ${singleLine(asString(data.reason))}`);
  }

  lines.push('', '### Recommended Next Step', '', '- Re-check page state via `get_page_info` or `get_page_content` if needed.');
  return lines.join('\n');
}


function formatTabList(data: AnyRecord): string {
  const detail = resolveDetailLevel(data);
  const tabs = Array.isArray(data.tabs) ? data.tabs : [];
  const topTabs = tabs.slice(0, pickByDetail(detail, { brief: 10, normal: 20, full: 40 }));
  const activeTabId = asString(data.activeTabId) || '-';

  const lines = [
    '## Tab List',
    '',
    `- Active Tab ID: ${activeTabId}`,
    `- Returned Tabs: ${tabs.length}`,
    '',
    '| id | active | title | url |',
    '|---|---|---|---|',
  ];

  if (topTabs.length === 0) {
    lines.push('| - | - | - | - |');
  } else {
    for (const tab of topTabs) {
      const id = asString(tab?.id) || '-';
      const active = id === activeTabId ? 'yes' : 'no';
      const title = compactText(asString(tab?.title) || '-', 80);
      const url = compactText(asString(tab?.url) || '-', 120);
      lines.push(`| ${tableSafe(id)} | ${active} | ${tableSafe(title)} | ${tableSafe(url)} |`);
    }
  }

  lines.push('', '### Recommended Next Step', '', '- Use `switch_tab` with target tab ID before interacting.');
  return lines.join('\n');
}

function formatDialogInfo(data: AnyRecord): string {
  const pending = isObject(data.pendingDialog) ? data.pendingDialog : null;
  const detail = resolveDetailLevel(data);
  const history = Array.isArray(data.dialogHistory) ? data.dialogHistory : [];
  const recent = history.slice(-pickByDetail(detail, { brief: 5, normal: 10, full: 20 })).reverse();

  const lines = [
    '## Dialog Status',
    '',
    `- Pending Dialog: ${pending ? 'yes' : 'no'}`,
    `- History Entries: ${history.length}`,
  ];

  if (pending) {
    lines.push(`- Pending Type: ${asString(pending.type) || '-'}`);
    lines.push(`- Pending Message: ${compactText(asString(pending.message) || '-', 180)}`);
  }

  lines.push('', '### Recent Dialog History', '', '| type | handled | message |', '|---|---|---|');

  if (recent.length === 0) {
    lines.push('| - | - | No dialog history |');
  } else {
    for (const item of recent) {
      lines.push(`| ${tableSafe(asString(item?.type) || '-')} | ${boolText(item?.handled)} | ${tableSafe(compactText(asString(item?.message) || '-', 100))} |`);
    }
  }

  lines.push('', '### Recommended Next Step', '');
  if (pending) {
    lines.push('- Call `handle_dialog` before other page interactions.');
  } else {
    lines.push('- No blocking native dialog; continue normal browsing flow.');
  }

  return lines.join('\n');
}

function formatNetworkLogs(data: AnyRecord): string {
  const detail = resolveDetailLevel(data);
  const logs = Array.isArray(data.logs) ? data.logs : [];
  const topLogs = logs.slice(-pickByDetail(detail, { brief: 10, normal: 20, full: 40 })).reverse();
  const total = numberOrNull(data.totalCount);
  const failed = logs.filter((l: any) => Boolean(l?.error) || ((asNumber(l?.status) ?? 0) >= 400)).length;

  if (detail === 'brief') {
    const topIssues = Array.isArray(data.topIssues) ? data.topIssues : [];
    const issue = topIssues[0];
    const blocker = issue
      ? `${asString(issue?.kind) || 'issue'} x${numberOrNull(issue?.count) ?? 0}`
      : (failed > 0 ? `failed=${failed}` : 'none');
    return formatBriefStatusResultBlock({
      title: 'Network Logs',
      status: `returned=${logs.length}${typeof total === 'number' ? `/${total}` : ''}; truncated=${boolText(data.truncated)}`,
      result: `failed=${failed}`,
      blocker,
      next: Boolean(data.hasMore) ? 'Call `get_network_logs` with `nextCursor`/higher `maxEntries`.' : 'Use `filter=failed` or `urlPattern` to narrow issues.',
    });
  }

  const lines = [
    '## Network Logs',
    '',
    `- Returned Entries: ${logs.length}`,
    `- Total Before Truncation: ${typeof total === 'number' ? total : '-'}`,
    `- Failed Entries: ${failed}`,
    `- Truncated: ${boolText(data.truncated)}`,
  ];

  const topIssues = Array.isArray(data.topIssues) ? data.topIssues : [];
  if (topIssues.length > 0) {
    const issueText = topIssues
      .slice(0, pickByDetail(detail, { brief: 2, normal: 3, full: 5 }))
      .map((issue: any) => `${asString(issue?.kind) || 'issue'} x${numberOrNull(issue?.count) ?? 0}`)
      .join(' ; ');
    lines.push(`- Top Issues: ${issueText}`);
  }

  lines.push('', '| method | status | type | duration(ms) | url |', '|---|---:|---|---:|---|');

  if (topLogs.length === 0) {
    lines.push('| - | - | - | - | No network logs |');
  } else {
    for (const log of topLogs) {
      const method = asString(log?.method) || '-';
      const status = asNumber(log?.status);
      const type = asString(log?.resourceType) || '-';
      const duration = asNumber(log?.timing?.duration);
      const url = compactText(asString(log?.url) || '-', 100);
      lines.push(`| ${tableSafe(method)} | ${status ?? '-'} | ${tableSafe(type)} | ${duration !== null ? duration.toFixed(0) : '-'} | ${tableSafe(url)} |`);
    }
  }

  lines.push('', '### Recommended Next Step', '', '- Use `filter=failed` or `urlPattern` to quickly narrow issues.');
  return lines.join('\n');
}

function formatConsoleLogs(data: AnyRecord): string {
  const detail = resolveDetailLevel(data);
  const logs = Array.isArray(data.logs) ? data.logs : [];
  const topLogs = logs.slice(-pickByDetail(detail, { brief: 15, normal: 30, full: 60 })).reverse();
  const counts = {
    error: logs.filter((l: any) => asString(l?.level) === 'error').length,
    warn: logs.filter((l: any) => asString(l?.level) === 'warn').length,
    info: logs.filter((l: any) => asString(l?.level) === 'info').length,
    log: logs.filter((l: any) => asString(l?.level) === 'log').length,
    debug: logs.filter((l: any) => asString(l?.level) === 'debug').length,
  };

  if (detail === 'brief') {
    const topIssues = Array.isArray(data.topIssues) ? data.topIssues : [];
    const issue = topIssues[0];
    const blocker = issue
      ? `${asString(issue?.kind) || 'issue'} x${numberOrNull(issue?.count) ?? 0}`
      : (counts.error > 0 || counts.warn > 0 ? `error=${counts.error}, warn=${counts.warn}` : 'none');
    return formatBriefStatusResultBlock({
      title: 'Console Logs',
      status: `entries=${logs.length}; truncated=${boolText(data.truncated)}`,
      result: `error=${counts.error}, warn=${counts.warn}, info=${counts.info}`,
      blocker,
      next: Boolean(data.hasMore) ? 'Call `get_console_logs` with `nextCursor`/higher `maxEntries`.' : 'Fix error/warn first; widen to `level=all` only when needed.',
    });
  }

  const lines = [
    '## Console Logs',
    '',
    `- Returned Entries: ${logs.length}`,
    `- error: ${counts.error}, warn: ${counts.warn}, info: ${counts.info}, log: ${counts.log}, debug: ${counts.debug}`,
    `- Truncated: ${boolText(data.truncated)}`,
  ];

  const topIssues = Array.isArray(data.topIssues) ? data.topIssues : [];
  if (topIssues.length > 0) {
    const issueText = topIssues
      .slice(0, pickByDetail(detail, { brief: 2, normal: 3, full: 5 }))
      .map((issue: any) => `${asString(issue?.kind) || 'issue'} x${numberOrNull(issue?.count) ?? 0}`)
      .join(' ; ');
    lines.push(`- Top Issues: ${issueText}`);
  }

  lines.push('', '| level | timestamp | text |', '|---|---|---|');

  if (topLogs.length === 0) {
    lines.push('| - | - | No console logs |');
  } else {
    for (const log of topLogs) {
      const ts = asNumber(log?.timestamp);
      const tsText = ts === null ? '-' : new Date(ts).toISOString();
      lines.push(`| ${tableSafe(asString(log?.level) || '-')} | ${tableSafe(tsText)} | ${tableSafe(compactText(asString(log?.text) || '-', 120))} |`);
    }
  }

  lines.push('', '### Recommended Next Step', '', '- Fix error/warn first; use `level=all` only when deeper debugging is required.');
  return lines.join('\n');
}

function formatRunSubmit(data: AnyRecord): string {
  const lines = [
    '## Task Run Submitted',
    '',
    `- Run ID: ${asString(data.runId) || '-'}`,
    `- Session ID: ${asString(data.sessionId) || '-'}`,
    `- Status: ${asString(data.status) || '-'}`,
    `- Mode: ${asString(data.mode) || '-'}`,
    '',
    '### Recommended Next Step',
    '',
    '- Call `get_task_run` with this runId until terminal status.',
  ];
  return lines.join('\n');
}

function formatRunStatus(data: AnyRecord): string {
  const detail = resolveDetailLevel(data);
  const done = asNumber(data.progress?.doneSteps);
  const total = asNumber(data.progress?.totalSteps);

  if (detail === 'brief') {
    const status = asString(data.status) || '-';
    const progressText = done !== null && total !== null ? `${done}/${total}` : '-';
    const verification = extractVerificationSnapshot(data);
    const resultParts = [
      asString(data.resultSummary) ? compactText(asString(data.resultSummary), 100) : null,
      Array.isArray(data.artifactIds) ? `artifacts=${data.artifactIds.length}` : null,
      `progress=${progressText}`,
      verification && !verification.pass
        ? `schema(missing=${verification.missingFields.length}, type=${verification.typeMismatches.length})`
        : null,
    ].filter(Boolean);
    const blocker = verification && !verification.pass
      ? `schema verification failed${verification.reason ? `: ${verification.reason}` : ''}`
      : (data.error ? compactText(singleLine(JSON.stringify(data.error)), 120) : 'none');
    const next = status === 'queued' || status === 'running'
      ? 'Continue polling `get_task_run` until terminal status.'
      : (Array.isArray(data.artifactIds) && data.artifactIds.length > 0)
        ? 'Fetch evidence with `get_artifact`.'
        : 'Inspect `result` and decide whether retry is needed.';

    return formatBriefStatusResultBlock({
      title: 'Task Run Status',
      status: `${status}; runId=${asString(data.runId) || '-'}`,
      result: resultParts.join('; ') || 'no summary',
      blocker,
      next,
    });
  }

  const lines = [
    '## Task Run Status',
    '',
    `- Run ID: ${asString(data.runId) || '-'}`,
    `- Template: ${asString(data.templateId) || '-'}`,
    `- Status: ${asString(data.status) || '-'}`,
    `- Progress: ${done !== null && total !== null ? `${done}/${total}` : '-'}`,
  ];

  if (Array.isArray(data.artifactIds) && data.artifactIds.length > 0) {
    lines.push(`- Artifact IDs: ${data.artifactIds.join(', ')}`);
  }
  if (asString(data.resultSummary)) {
    lines.push(`- Result Summary: ${compactText(asString(data.resultSummary), 220)}`);
  }
  if (Array.isArray(data.evidenceRefs) && data.evidenceRefs.length > 0) {
    const refs = data.evidenceRefs
      .slice(0, 6)
      .map((ref: any) => `${asString(ref?.artifactId) || '-'}(${asString(ref?.reason) || 'evidence'})`)
      .join(', ');
    lines.push(`- Evidence Refs: ${refs}`);
  }
  const verification = extractVerificationSnapshot(data);
  if (verification && !verification.pass) {
    lines.push(`- Verification: pass=false, missing=${verification.missingFields.length}, type=${verification.typeMismatches.length}`);
    if (verification.missingFields.length > 0) {
      lines.push(`- Missing Fields: ${verification.missingFields.slice(0, 12).join(', ')}`);
    }
    if (verification.typeMismatches.length > 0) {
      lines.push(`- Type Mismatches: ${verification.typeMismatches.slice(0, 12).join(', ')}`);
    }
  }
  if (Array.isArray(data.schemaRepairHints) && data.schemaRepairHints.length > 0) {
    lines.push(`- Schema Repair Hints: ${data.schemaRepairHints.slice(0, 4).map((item: unknown) => singleLine(String(item))).join(' ; ')}`);
  }
  if (data.error) {
    lines.push(`- Error: ${singleLine(JSON.stringify(data.error))}`);
  }

  lines.push('', '### Recommended Next Step', '');
  if (data.status === 'queued' || data.status === 'running') {
    lines.push('- Continue polling `get_task_run`.');
  } else if (Array.isArray(data.artifactIds) && data.artifactIds.length > 0) {
    lines.push('- Retrieve artifacts with `get_artifact`.');
  } else {
    lines.push('- Inspect `result` and decide whether a retry is needed.');
  }

  return lines.join('\n');
}

function formatRunList(data: AnyRecord): string {
  const detail = resolveDetailLevel(data);
  const runs = Array.isArray(data.runs) ? data.runs.slice(0, pickByDetail(detail, { brief: 10, normal: 20, full: 40 })) : [];

  if (detail === 'brief') {
    const first = runs[0];
    const firstStatus = first ? `${asString(first?.runId) || '-'}:${asString(first?.status) || '-'}` : 'none';
    return formatBriefStatusResultBlock({
      title: 'Task Run List',
      status: `returned=${Array.isArray(data.runs) ? data.runs.length : 0}; total=${numberOrNull(data.total) ?? '-'}`,
      result: `latest=${firstStatus}`,
      blocker: Boolean(data.hasMore) ? 'more runs available via nextCursor' : 'none',
      next: first ? 'Call `get_task_run` for the latest run.' : 'Submit a new task run if no records exist.',
    });
  }

  const lines = [
    '## Task Run List',
    '',
    `- Returned Runs: ${Array.isArray(data.runs) ? data.runs.length : 0}`,
    `- Total (filtered): ${numberOrNull(data.total) ?? '-'}`,
    '',
    '| runId | templateId | status | progress |',
    '|---|---|---|---|',
  ];

  if (runs.length === 0) {
    lines.push('| - | - | - | - |');
  } else {
    for (const run of runs) {
      const done = asNumber(run?.progress?.doneSteps);
      const total = asNumber(run?.progress?.totalSteps);
      const progress = done !== null && total !== null ? `${done}/${total}` : '-';
      lines.push(`| ${tableSafe(asString(run?.runId) || '-')} | ${tableSafe(asString(run?.templateId) || '-')} | ${tableSafe(asString(run?.status) || '-')} | ${progress} |`);
    }
  }

  lines.push('', '### Recommended Next Step', '', '- Pick a runId and call `get_task_run` for details.');
  return lines.join('\n');
}

function formatArtifact(data: AnyRecord): string {
  const lines = [
    '## Artifact Chunk',
    '',
    `- Artifact ID: ${asString(data.artifactId) || '-'}`,
    `- MIME Type: ${asString(data.mimeType) || '-'}`,
    `- Offset: ${numberOrNull(data.offset) ?? '-'}`,
    `- Length: ${numberOrNull(data.length) ?? '-'}`,
    `- Total Size: ${numberOrNull(data.totalSize) ?? '-'}`,
    `- Complete: ${boolText(data.complete)}`,
    '',
    '### Recommended Next Step',
    '',
    data.complete
      ? '- Artifact fully retrieved.'
      : '- Continue with a larger offset in `get_artifact` to fetch remaining chunks.',
  ];
  return lines.join('\n');
}


function toDisplayText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function compactState(state: unknown): string {
  if (!isObject(state)) return '-';
  const importantKeys = ['value', 'checked', 'selected', 'disabled', 'expanded'];
  const picked = importantKeys
    .filter((key) => key in state)
    .map((key) => `${key}:${singleLine(String((state as AnyRecord)[key]))}`);
  if (picked.length === 0) return '-';
  return compactText(picked.join(', '), 60);
}

function boolText(value: unknown): string {
  return Boolean(value) ? 'yes' : 'no';
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return asNumber(value);
}

function asCursor(value: unknown): AnyRecord | null {
  return isObject(value) ? value : null;
}

function buildMaxEntriesCursorArgs(cursor: AnyRecord | null): Record<string, unknown> | null {
  if (!cursor) return null;
  const suggestedMaxEntries = numberOrNull(cursor.suggestedMaxEntries);
  if (suggestedMaxEntries === null) return null;
  return { maxEntries: suggestedMaxEntries };
}

function buildListRunsCursorArgs(cursor: AnyRecord | null): Record<string, unknown> | null {
  if (!cursor) return null;
  const offset = numberOrNull(cursor.offset);
  const limit = numberOrNull(cursor.limit);
  if (offset === null && limit === null) return null;

  const args: Record<string, unknown> = {};
  if (offset !== null) args.offset = offset;
  if (limit !== null) args.limit = limit;
  return args;
}

function numberText(value: unknown): string {
  const n = asNumber(value);
  return n === null ? '-' : n.toFixed(3);
}

function compactText(value: string, maxLen: number): string {
  const oneLine = singleLine(value);
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxLen - 1))}…`;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function tableSafe(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function isObject(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
