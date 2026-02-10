# Agent v1 实施计划（8 周，修订版）

> 状态：Draft
> 目标：将当前测试导向的 `BrowsingAgent` 升级为任务交付导向的 `TaskAgent`
> 关联文档：`docs/13-intelligent-browser-terminal-prd-v1-draft.md`、`docs/14-v1-mcp-contract-v1.md`

## 1. 实施原则

- 增量改造：复用 `BrowsingAgent`，新增 `TaskAgent` 壳层。
- template-first：优先走确定性模板，减少不必要的开放式推理。
- 可回滚：保留旧 `/v1/agent` 入口与事件协议，逐步迁移。

## 2. 目标架构（v1）

```text
TaskAgent
  ├─ Planner    (新增)
  ├─ Executor   (复用 BrowsingAgent / MCP task tools)
  └─ Verifier   (新增：程序化 outputSchema 校验)
```

职责划分：
- Planner：把 TaskSpec 映射到执行计划（PlanStep）。
- Executor：按计划执行并返回 result + artifacts。
- Verifier：校验输出是否满足 schema，不满足则触发补救。

## 3. Planner 方案（v1 冻结选择）

### 3.1 选择：规则优先 + LLM 兜底（可开关）

- **阶段 1（默认）**：规则引擎（关键词 + 任务特征）映射到 template。
- **阶段 2（兜底）**：规则未命中时，允许一次轻量 LLM 分类调用。

这样做的原因：
- 规则路径可控、可测、成本稳定。
- LLM 仅用于“无法规则分类”的 tail case，降低不确定性。

规则与 LLM 都无法映射到 template 时：
- 默认降级为 `agent_goal` 类型 PlanStep。
- Executor 以该 `goal` 驱动 `BrowsingAgent` 自由执行，并继续受 `budget/maxRetries` 约束。

### 3.2 LLM 调用策略（若启用）

- 与 Executor 共用同一模型配置（避免多套配置漂移）。
- Planner 最多 1 次 LLM 调用，超出直接降级到默认模板或失败。
- token 消耗纳入任务 metrics（v1 记录，v1.1 再做硬预算）。

### 3.3 `planner.repair` 职责（补充）

- `planner.repair(verify, lastRunContext)` 用于根据验收失败原因生成补救 PlanStep。
- 典型场景：缺失字段 -> 增加定向提取 step；类型不匹配 -> 增加格式化/二次提取 step。
- 输出是“补丁计划”（patch plan），由 TaskAgent 主循环合并并再次交给 Executor。

## 4. API 与接入路径（明确）

### 4.1 后端入口

- 保持现有 `/v1/agent` 不变（兼容旧流程）。
- 新增 TaskAgent 入口：
  - `POST /v1/tasks`：提交 TaskSpec，返回 taskId/runId
  - `GET /v1/tasks/:id`：查询任务状态与结果
  - `GET /v1/tasks/:id/events`：SSE 事件流（可复用现有事件分发机制）

### 4.2 前端适配（最小范围）

- 保留现有 Agent 调试页面。
- 新增任务提交页（TaskSpec 表单）。
- 新增任务结果页（状态、进度、验证结果、产物列表）。

## 5. 关键类型定义（修订）

### 5.1 PlanStep

```ts
type PlanStep = {
  id: string;
  type: 'template' | 'agent_goal';
  templateId?: string;                 // type=template
  inputs?: Record<string, unknown>;    // type=template
  goal?: string;                       // type=agent_goal
  fallbackStepIds?: string[];          // 失败回退 step id
  dependsOn?: string[];                // 前置依赖 step id
};
```

执行语义（v1）：
- v1 仅支持线性顺序执行（按 PlanStep 数组顺序）。
- `dependsOn` 为预留字段，v1.1 再支持 DAG/并行调度。

### 5.2 VerifyResult

```ts
type VerifyResult = {
  pass: boolean;
  score: number;
  missingFields: string[];
  typeMismatches: string[];
  reason?: string;
};
```

### 5.3 TaskAgentResult

```ts
type TaskAgentResult = {
  success: boolean;
  runId?: string;
  summary: string;
  result?: unknown;
  artifacts: string[];
  verification: VerifyResult;
  iterations: number;
};
```

## 6. Verifier 补救流程（明确边界）

- 补救发起方：TaskAgent 主循环（不是 Verifier 直接执行工具）。
- 会话策略：默认重用当前 session；仅在 `PAGE_CRASHED/SESSION_NOT_FOUND` 时重建。
- 次数上限：受 `budget.maxRetries` 控制。

伪代码：

```text
result = executor.run(plan)
verify = verifier.check(result, outputSchema)
retries = 0
while !verify.pass and retries < budget.maxRetries:
  patchPlan = planner.repair(verify, lastRunContext)
  result = executor.run(patchPlan, reuseSession=true)
  verify = verifier.check(result, outputSchema)
  retries += 1
if !verify.pass: fail
else success
```

## 7. 事件协议（与现有兼容）

现有事件保留并透传：
- `session_created`、`thinking`、`tool_call`、`tool_result`、`input_required`、`error`、`done`

新增事件（TaskAgent）：
- `plan_created`
- `verification_result`
- `repair_attempted`

兼容策略：
- 旧前端可忽略新增事件类型，不影响现有显示。

## 8. 里程碑与任务拆解（修订）

## Milestone A（W1-W2）：基线与设计冻结

交付物：
- TaskSpec / ArtifactMetadata 字段冻结
- 基线报告（成功率、TTD、无人工介入率）
- Planner/Verifier 设计文档

任务：
- [ ] 梳理 `BrowsingAgent` 扩展点
- [ ] 输出规则优先 Planner 方案与关键词映射表
- [ ] 定义事件协议扩展与前端兼容策略

## Milestone B（W3）：壳层 + Verifier

任务：
- [ ] 新增 `src/agent/task-agent.ts` 壳层
- [ ] Verifier 程序化校验（JSON Schema）
- [ ] TaskAgentResult 输出结构打通

## Milestone C（W4）：Planner 最小实现 + 恢复策略

任务：
- [ ] Planner 规则路径
- [ ] 可选 LLM 兜底路径（开关控制）
- [ ] 4 类恢复策略：`ELEMENT_NOT_FOUND` / `NAVIGATION_TIMEOUT` / `INVALID_PARAMETER` / `RUN_TIMEOUT`

## Milestone D（W5）：集成联调与评测

任务：
- [ ] TaskAgent + MCP task runtime 联调
- [ ] 任务级评测集跑通（>=10 场景）
- [ ] 指标对比基线

## Milestone E（W6）：后端交付能力

任务：
- [ ] 输出验收报告（summary + evidence + verification）
- [ ] 新增 `/v1/tasks` 入口与 SSE

## Milestone F（W7）：前端最小页与联调

任务：
- [ ] 前端任务提交/结果页最小可用
- [ ] `/v1/tasks` 与前端端到端联调

## Milestone G（W8）：回归与发布


任务：
- [ ] 回归 + 压测（100 runs）
- [ ] 发布门槛审查
- [ ] 文档闭环

## 9. 测试策略

### 9.1 单元测试

- Planner 规则映射（goal -> PlanStep[]）
- Verifier 校验与失败分类
- 补救循环停止条件（maxRetries）

### 9.2 集成测试

- TaskAgent -> MCP task tools 端到端
- sync/async/auto 三模式兼容
- 事件协议兼容（旧事件 + 新事件）

### 9.3 回归测试

- 现有 `BrowsingAgent` API 不破坏
- 现有 7 个 task runtime 工具契约不破坏

## 10. 指标与发布门槛

- 首轮成功率（任务级）>= 80%
- 无人工介入完成率 >= 70%
- TTD 较基线下降 >= 30%
- 验收报告完整率 >= 95%

## 11. 风险与缓解

- Planner 规则覆盖不足：引入可选 LLM 兜底 + 规则持续扩充。
- 三段式带来时延：小任务优先 template direct run。
- 无持久化导致重启任务丢失：v1 明确边界，v1.1 补齐持久化。

## 12. v1.1 前瞻（不纳入本期）

- `subscribe_task_run_events`
- checkpoint/resume
- run/artifact 元数据持久化
- token 预算硬阈值
