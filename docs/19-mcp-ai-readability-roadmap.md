# MCP AI Readability Roadmap (P0–P2)

> Status: Active
> Owner: MCP + Agent team
> Last Updated: 2026-02-11
> Related: `docs/14-v1-mcp-contract-v1.md`, `docs/15-v1-agent-implementation-plan.md`, `docs/18-mcp-ai-consumer-guide.md`

## 1) Goal

Continuously improve MCP tool responses so AI agents can:

- make correct next-step decisions with fewer retries,
- consume less context for the same task outcome,
- recover from partial failure in a deterministic way.

## 2) Success Metrics

- **First-action correctness**: >= 85% for benchmark tasks
- **Invalid tool-call rate**: <= 5%
- **Recovery success rate** (after non-terminal issue): >= 70%
- **Token overhead** introduced by AI helper fields: <= 20% (normal detail level)
- **Backward compatibility**: 0 breaking changes to existing response fields

## 3) Priority Plan

### P0 — Foundation Hardening (Done / Stabilizing)

### Scope

- Additive AI helper fields on key tools:
  - `aiSchemaVersion`, `aiDetailLevel`, `aiSummary`, `aiMarkdown`, `aiHints`, `nextActions`
- Continuation semantics normalization:
  - `hasMore` + `nextCursor`
- Log triage acceleration:
  - `topIssues` for network/console logs
- Task execution readability:
  - `resultSummary`, `evidenceRefs` in task run responses
- Intent alignment:
  - `recommendedByIntent` in `get_page_info`
- Configurable detail level:
  - `AI_MARKDOWN_DETAIL_LEVEL=brief|normal|full`

### Deliverables

- `src/mcp/ai-markdown.ts`
- MCP wiring in browser tools + task tools
- regression tests + formatter unit tests
- AI consumer guides (EN/CN)

### Exit Criteria

- build passes
- non-browser targeted tests pass
- no contract-breaking field changes

### P1 — Decision Quality Upgrade (In Progress)

### Scope

1. **Actionability standardization**
   - normalize `nextActions` quality (reason text consistency, priority calibration)
   - add clearer stop/continue signals for list/log/task status tools
2. **Signal compaction**
   - reduce repetitive markdown sections in `brief` mode
   - keep high-signal facts first (status/result/blocker)
3. **Consumer prompt alignment**
   - align built-in agent prompt with `nextActions` first strategy
   - add examples for external MCP clients
4. **Observability for AI consumption quality**
   - track helper-field adoption in benchmark scripts
   - output markdown quality notes in reports

### Deliverables

- formatter refinements in `src/mcp/ai-markdown.ts`
- prompt alignment updates in `src/agent/prompt.ts`
- benchmark/report script updates
- docs refresh in README + guides

### Exit Criteria

- benchmark invalid tool-call rate improves by >= 15% vs P0 baseline
- no degradation in task success rate

### P2 — Adaptive Intelligence Layer (Planned)

### Scope

1. **Adaptive response shaping**
   - dynamic detail policy by task phase (planning/execution/recovery)
   - optional compact mode for high-frequency polling tools
2. **Delta-oriented updates**
   - expose concise "what changed" summaries for repeated polling outputs
3. **Schema-aware guidance**
   - for schema-constrained tasks, produce stronger mismatch hints and repair-oriented actions
4. **Evaluation harness expansion**
   - add scenario sets for long-running tasks, flaky pages, and partial-success recovery

### Deliverables

- adaptive formatter strategy extensions
- optional delta block on polling results
- extended evaluation scripts + report templates
- contract notes for additive fields

### Exit Criteria

- recovery success rate improves by >= 10% vs P1
- token overhead remains within budget under `normal`

## 4) Milestone Timeline

- **W1 (P0 stabilize)**: complete regression/test/documentation hardening
- **W2–W3 (P1)**: actionability + compaction + prompt alignment + benchmark diff
- **W4+ (P2)**: adaptive/delta/evaluation expansion

## 5) Risks & Mitigations

- **Risk**: helper fields become verbose and increase token cost
  - **Mitigation**: strict `brief/normal/full` policy + benchmark token budget gate
- **Risk**: additive fields diverge across tools
  - **Mitigation**: shared formatter module and regression tests by tool category
- **Risk**: external clients overfit helper fields and ignore source fields
  - **Mitigation**: docs clearly state raw fields remain source of truth

## 6) Execution Checklist

- [x] P0 helper fields + continuation/topIssues + base docs
- [x] P0 formatter and regression tests
- [x] P1 stop/continue signal enhancement for log and run-list tools
- [x] P1 nextActions quality calibration sweep
- [x] P1 benchmark/report metric expansion
- [x] P1 brief-mode compaction with fixed status/result/blocker ordering
- [x] P1 AI consumer guide examples for polling and repair loops
- [x] P2 adaptive detail policy prototype
- [x] P2 delta summary prototype for polling tools
- [x] P2 schema-aware repair guidance for constrained tasks
- [x] P2 expanded scenario benchmark

