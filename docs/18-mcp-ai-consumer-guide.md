# MCP AI Consumer Guide

This guide explains how AI consumers (Claude Desktop/Cursor/custom MCP clients) should consume `ai-browser` tool results for stable task execution.

## 1) Prerequisites

- Start the MCP server:
  - stdio: `ai-browser-mcp`
  - SSE: `ai-browser --port 3000` then connect to `http://127.0.0.1:3000/mcp/sse`
- (Optional) configure AI detail level on server side:
  - `AI_MARKDOWN_DETAIL_LEVEL=brief|normal|full`
  - default is `normal`
- `AI_MARKDOWN_ADAPTIVE_POLICY=1` (prototype)
  - adaptive detail for polling and failure states

## 2) AI-Optimized Fields (Additive)

Tool responses keep original JSON fields and add:

- `aiSchemaVersion`: schema version for AI helper fields
- `aiDetailLevel`: effective detail level used by formatter
- `aiSummary`: one-line status summary
- `aiMarkdown`: compact structured markdown (tables + key signals)
- `aiHints`: text recommendations for next steps
- `nextActions`: structured action suggestions
- `deltaSummary`: optional polling delta (`key` + list of change lines)
- `schemaRepairGuidance`: structured repair hints when schema verification fails
- In `brief` detail level, `aiMarkdown` prioritizes fixed ordering: `Status` -> `Result` -> `Blocker`

Example `nextActions` item:

```json
{
  "tool": "get_task_run",
  "args": { "runId": "..." },
  "reason": "Poll task run status until terminal state",
  "priority": "high"
}
```

## 3) Recommended Consumer Decision Order

For each tool result:

1. If `nextActions` exists and is non-empty, execute highest-priority first.
2. Else use `aiSummary` + `aiHints` to choose next step.
3. Use `aiMarkdown` only when you need more detail.
4. Fall back to raw tool fields as final source of truth.

## 4) Continuation & Pagination Semantics

List-like/log-like tools may return:

- `hasMore: boolean`
- `nextCursor: object | null`

Recommended behavior:

- If `hasMore === true`, continue by re-calling same tool with `nextCursor` guidance.
- If `hasMore === false`, stop paginating and move to downstream action.
- If `deltaSummary` exists, prioritize `changes` before scanning full payload.

## 5) Fast Failure Triage for Logs

`get_network_logs` and `get_console_logs` include:

- `topIssues`: aggregated high-signal issues (kind + count + sample)

Recommended behavior:

- inspect `topIssues` first
- then drill into raw `logs` only for the selected issue

## 6) Task Runtime Best Practices

For task tools:

- Use `run_task_template` -> follow `nextActions` (typically `get_task_run` polling)
- On terminal states, use:
  - `resultSummary` for concise interpretation
  - `evidenceRefs` + `artifactIds` for evidence retrieval
- When `schemaRepairGuidance` is present, prioritize its `missingFields`/`typeMismatches` before retrying

## 7) Prompting Guidance for MCP Agents

When building an AI agent system prompt, include rules like:

- prioritize `nextActions` over free-form planning when available
- use `aiSummary` for state transitions
- avoid reading full `aiMarkdown` unless needed
- respect `hasMore/nextCursor` continuation semantics

## 8) Compatibility

All AI helper fields are additive and backward-compatible:

- existing integrations consuming original fields remain valid
- consumers can incrementally adopt AI fields without breaking behavior

## 9) Roadmap

- For upcoming P0-P2 readability improvements and execution checklist, see:
  - `docs/19-mcp-ai-readability-roadmap.md`

## 10) Evaluation & Benchmark

Run baseline benchmark to track AI-readability metrics:

```bash
npm run baseline:v1
npm run benchmark:v1:expanded
```

The report now includes:
- `aiFieldCoverageRate`
- `invalidToolCallRate`
- `followUpActionSuccessRate`
- expanded report: `docs/reports/v1-expanded-benchmark.md`

## 11) Polling and Repair Examples

### Example A: Polling loop by `nextActions`

1. Call `run_task_template`
2. Read top `nextActions` item (usually `get_task_run`)
3. Repeat until task status becomes terminal (`succeeded` / `failed` / `partial_success` / `canceled`)
4. If `nextActions` suggests `get_artifact`, fetch evidence chunk(s)

### Example B: Schema mismatch recovery

If `get_task_run` ends with verification mismatch in task result:

1. inspect `verification.missingFields` and `verification.typeMismatches`
2. execute suggested follow-up actions from `nextActions` first
3. if no structured action is available, run targeted extraction (`get_page_info` / `find_element` / `get_page_content`)
4. re-run task with refined inputs or schema constraints

