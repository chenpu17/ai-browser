/**
 * Tool-aware content budget system for formatting MCP results for LLM consumption.
 * Prioritizes aiMarkdown/aiSummary fields from the MCP enrichment layer.
 */

/** Budget limits by tool category (in characters) */
const TOOL_BUDGETS: Record<string, number> = {
  // Navigation/action tools — concise results
  navigate: 2000,
  click: 2000,
  type_text: 2000,
  press_key: 2000,
  scroll: 2000,
  go_back: 2000,
  select_option: 2000,
  hover: 2000,
  set_value: 2000,
  wait: 2000,
  wait_for_stable: 2000,
  handle_dialog: 2000,
  upload_file: 2000,
  switch_tab: 2000,
  close_tab: 2000,
  create_tab: 2000,
  create_session: 2000,
  close_session: 2000,

  // Content extraction tools — need more space
  get_page_content: 6000,
  execute_javascript: 4000,
  get_network_logs: 4000,
  get_console_logs: 4000,

  // Page info tools — moderate space
  get_page_info: 4000,
  find_element: 3000,
  list_tabs: 3000,
  screenshot: 2000,
  get_dialog_info: 3000,
  get_downloads: 3000,

  // Task tools
  list_task_templates: 3000,
  run_task_template: 2000,
  get_task_run: 4000,
  list_task_runs: 3000,
  cancel_task_run: 2000,
  get_artifact: 6000,
  get_runtime_profile: 2000,

  // Composite tools
  fill_form: 4000,
  click_and_wait: 4000,
  navigate_and_extract: 6000,
};

const DEFAULT_BUDGET = 4000;
const SAFETY_MAX = 8000;

export function getToolBudget(toolName: string): number {
  return TOOL_BUDGETS[toolName] ?? DEFAULT_BUDGET;
}

/**
 * Format MCP tool result for LLM consumption.
 * Priority: aiMarkdown > aiSummary > raw JSON, all within budget.
 */
export function formatToolResult(rawText: string, toolName: string): string {
  const budget = getToolBudget(toolName);

  try {
    const data = JSON.parse(rawText);

    // Only process plain objects, not arrays or primitives
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return truncate(rawText, SAFETY_MAX);
    }

    // Priority 1: Use aiMarkdown if available and within budget
    if (typeof data.aiMarkdown === 'string' && data.aiMarkdown.length > 0) {
      const md = data.aiMarkdown;
      if (md.length <= budget) return md;
      // Over budget — try aiSummary as fallback
      if (typeof data.aiSummary === 'string' && data.aiSummary.length > 0) {
        return truncate(data.aiSummary, budget);
      }
      // Truncate aiMarkdown as last resort
      return truncate(md, budget);
    }

    // Priority 2: Use aiSummary if available
    if (typeof data.aiSummary === 'string' && data.aiSummary.length > 0) {
      return truncate(data.aiSummary, budget);
    }

    // Priority 3: Tool-specific formatting for legacy/non-enriched responses
    const formatted = formatLegacy(data, toolName);
    return truncate(formatted, SAFETY_MAX);
  } catch {
    return truncate(rawText, SAFETY_MAX);
  }
}

function formatLegacy(data: any, toolName: string): string {
  if (toolName === 'get_page_info' && data?.elements) {
    const summary: any = {
      page: data.page,
      elementCount: data.elements.length,
      elements: data.elements.slice(0, 30).map((e: any) => ({
        id: e.id,
        type: e.type,
        label: e.label,
      })),
      intents: data.intents,
    };
    if (data.stability) summary.stability = data.stability;
    if (data.pendingDialog) summary.pendingDialog = data.pendingDialog;
    if (data.elements.length > 30) {
      summary.note = `显示前30个元素，共${data.elements.length}个`;
    }
    return JSON.stringify(summary, null, 2);
  }

  if (toolName === 'get_page_content') {
    let md = `# ${data.title || ''}\n\n`;
    const sections = Array.isArray(data.sections) ? data.sections : [];
    for (const s of sections) {
      const stars = s.attention >= 0.7 ? '***'
                 : s.attention >= 0.4 ? '**'
                 : '*';
      md += `[${stars}] ${s.text}\n\n`;
    }
    if (sections.length === 0) md += '(未提取到内容)\n';
    return md;
  }

  return JSON.stringify(data);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n...(已截断，共${text.length}字符)`;
}
