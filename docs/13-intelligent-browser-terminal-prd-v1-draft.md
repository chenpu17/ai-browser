# 智能浏览器终端 PRD v1 初稿（修订版）

> 状态：Draft
> 适用范围：AI Browser（MCP 内核 + Agent 执行层）
> 文档目标：在现有实现基础上，增量升级为“任务交付型智能浏览器终端”

## 1. 现状与目标对照（避免误判改造量）

| 能力项 | 当前状态（代码） | v1 目标 | 改造级别 |
|---|---|---|---|
| 任务状态机 | 已有：`queued/running/succeeded/failed/partial_success/canceled`（`src/task/run-manager.ts`） | 保持状态机不变，补齐语义说明与对外契约 | 小改 |
| Task Runtime 工具 | 已有 7 个：`list_task_templates`、`run_task_template`、`get_task_run`、`list_task_runs`、`cancel_task_run`、`get_artifact`、`get_runtime_profile`（`src/mcp/task-tools.ts`） | 维持兼容，新增订阅能力（可延期） | 小改~中改 |
| Artifact 存储 | 已有分块与 TTL（`src/task/artifact-store.ts`，chunk=256KB，TTL=24h） | 在现有存储上补元数据索引，不替换底层分块机制 | 中改 |
| 错误码体系 | 已有（`src/task/error-codes.ts` + MCP 错误返回） | 复用现有错误码，按任务语义补映射规则 | 小改 |
| Agent 执行 | 已有 `BrowsingAgent` 循环执行、步数限制、ask_human（`src/agent/agent-loop.ts`） | 在其上增量引入 Planner/Verifier，不推翻执行内核 | 中改 |
| 结果交付 | 当前可返回 result + artifacts，但“可验收标准”不统一 | 引入 outputSchema 校验与证据链规范 | 中改 |

结论：v1 不是重写。以“契约统一 + Agent 增强 + 结果标准化”为主。

## 2. 产品愿景与定位

### 2.1 愿景

把 AI Browser 建成“接受人类任务并自动完成交付”的浏览器终端，而不是仅供人类手动操作的自动化工具集合。

### 2.2 定位

- 内核：MCP Task Runtime（可观测、可复用、可审计）
- 执行层：Task Agent（Planner / Executor / Verifier）
- 交付层：Result Center（结构化结果 + 证据链 + 可重跑）

## 3. v1 范围与非目标

### 3.1 v1 目标（8 周）

1. 统一任务输入契约（TaskSpec）与产物契约（ArtifactMetadata）。
2. 在现有 7 个 task 工具基础上完成语义收敛与兼容升级。
3. Agent 从“单循环工具调用”升级为“可校验交付”的三段式流程。
4. 建立任务级评测基线与发布门槛。

### 3.2 非目标（v1 不做）

- 不做多租户权限体系重构。
- 不做完整凭据托管系统（仅保留现有 cookie/session 机制）。
- 不做强持久化恢复（checkpoint/resume）作为 v1 发布门槛。

## 4. 核心架构澄清

### 4.1 TaskSpec 与 Template 的关系

- **Template 不是被替代**：`templateId + inputs` 仍是执行底座。
- **TaskSpec 是上层抽象**：用于承载任务目标、约束、验收标准。
- 执行路径有两种：
  1. 直接模式：客户端提交 `templateId + inputs`（现有兼容路径）。
  2. 任务模式：客户端提交 `TaskSpec.goal`，由 Planner 映射到 template 或步骤计划后执行。

### 4.2 三段式 Agent 与现有 BrowsingAgent 的关系

v1 采用“组合/增量”而非替换：

- Planner：新增模块，负责任务拆解与策略选择。
- Executor：复用现有 `BrowsingAgent` 的工具执行能力与会话管理能力。
- Verifier：新增模块，负责 outputSchema 程序化校验。

实现形态建议：`TaskAgent`（新）包裹 `BrowsingAgent`（旧），避免一次性重构风险。

### 4.3 Verifier 的校验方式（明确）

- v1 采用**程序化 JSON Schema 校验**为主（非 LLM 判定）。
- 校验失败分级：
  - 字段缺失：可补救（触发补充步骤）
  - 类型错误：可修复（转换或重提取）
  - 完全无结果：直接失败或 ask_human（取决于 `allowHumanInput`）

## 5. 数据契约（v1）

### 5.1 TaskSpec v0.1（精简版）

> 说明：移除当前未实现能力字段（如 `priority`、`deadline`、`accountRef`）。

```json
{
  "taskId": "task_20260210_001",
  "goal": "提取今日订单摘要",
  "inputs": {
    "entryUrl": "https://example.com/dashboard"
  },
  "constraints": {
    "maxDurationMs": 300000,
    "maxSteps": 30,
    "allowHumanInput": true
  },
  "budget": {
    "maxToolCalls": 80,
    "maxRetries": 3
  },
  "outputSchema": {
    "type": "object",
    "required": ["date", "orderCount", "totalAmount"],
    "properties": {
      "date": { "type": "string" },
      "orderCount": { "type": "number" },
      "totalAmount": { "type": "number" }
    }
  }
}
```

### 5.2 ArtifactMetadata v0.1（在现有 ArtifactStore 上扩展）

- 现有 `artifact-store` 继续负责分块数据存储。
- 新增元数据索引（建议挂在 RunManager 或独立 map）：

```json
{
  "artifactId": "art_xxx",
  "runId": "run_xxx",
  "type": "result_json",
  "mimeType": "application/json",
  "size": 2048,
  "createdAt": "2026-02-10T12:00:00Z",
  "summary": "订单摘要结果",
  "evidence": {
    "url": "https://example.com/dashboard",
    "relatedArtifactIds": ["art_img_xxx", "art_dom_xxx"]
  }
}
```

元数据生成责任：
- 模板执行器：生成结果类 metadata（`result_json/csv/markdown`）。
- MCP 工具层：生成日志/截图类 metadata（如有）。
- Agent：仅补充任务级 summary，不直接重写 artifact 元数据。

TTL 策略：
- 与现有 artifact TTL 一致（默认 24h）。
- 到期按 run 维度清理，`relatedArtifactIds` 仅用于展示，不做复杂级联引用约束。

## 6. MCP 契约（v1）

### 6.1 工具状态表

| 工具 | 状态 | v1 动作 |
|---|---|---|
| `list_task_templates` | 已有 | 保持 |
| `run_task_template` | 已有 | 改造：补 idempotencyKey / outputSchema（可选） |
| `get_task_run` | 已有 | 改造：统一终态/非终态字段语义 |
| `list_task_runs` | 已有 | 保持 + 文档明确分页/过滤 |
| `cancel_task_run` | 已有 | 保持 |
| `get_artifact` | 已有 | 保持（沿用 256KB 分块） |
| `get_runtime_profile` | 已有 | 保持 + 增补预算相关字段 |
| `subscribe_task_run_events` | 新增（候选） | 建议 v1.1，v1 用 polling |

### 6.2 sync/async 策略（采纳评审建议）

- v1 不强制 async-only。
- 保留现有 `sync/async/auto` 模式以兼容集成方。
- 对 Agent 默认策略：优先 async（长任务），小任务可 auto。
- `outputSchema` 验收执行方：v1 仅在 TaskAgent 路径由 Verifier 执行；直接模板执行路径（纯 `run_task_template`）默认忽略该字段。

## 7. 资源与并发模型（补充）

### 7.1 并发池

- 模板任务与 Agent 任务共享同一任务并发池（v1 默认与 RunManager 对齐，当前上限 5）。
- 当并发池被占满时，后续任务统一排队，不区分模板任务与 Agent 任务优先级（FIFO）。
- 这意味着：若 5 个模板任务占满并发，Agent 任务会被阻塞等待；反之亦然。优先级队列不在 v1 范围。

### 7.2 预算计量

- `maxToolCalls`：Executor 侧硬限制。
- `maxRetries`：Verifier 触发补救链路的上限。
- LLM token 预算：v1 仅记录，不作为强拒绝阈值（v1.1 再做硬预算）。

### 7.3 浏览器资源上限

- 会话与 tab 上限遵循现有 SessionManager 限制。
- 任务调度层需避免超过单实例稳定阈值（通过队列限流）。

## 8. 持久化策略（补充）

v1 明确采用“内存态 + 有损重启”策略：

- 运行中任务与内存 run 状态在进程重启后丢失（当前行为）。
- 这是 v1 可接受边界，但必须在文档和运行提示中明确。
- v1.1 目标：引入 run/artifact 元数据持久化 + resume 能力。

## 9. 可观测性与追踪（补充）

最小观测规范：

- `traceId` 生成方：RunManager 在创建 run 时生成并挂载到 RunState（或等效上下文对象）。
- `traceId` 传播链路：RunManager -> TaskAgent -> BrowsingAgent/ToolContext，确保 run -> step -> tool_call 可串联。
- 结构化日志至少包含：`runId`、`traceId`、`templateId`、`step`、`status`、`errorCode`、`elapsedMs`。
- 是否持久化日志：v1 可选（默认内存 + 控制台），v1.1 统一落盘/外部系统。

日志示例（JSON）：

```json
{
  "ts": "2026-02-10T12:00:00.123Z",
  "level": "info",
  "traceId": "trace_01HXYZ",
  "runId": "run_01HXYZ",
  "templateId": "batch_extract_pages",
  "step": "extract_page#3",
  "status": "running",
  "elapsedMs": 1842
}
```

## 10. 里程碑计划（8 周，修正）

### Milestone A（W1-W2：设计与基线）

- 冻结 `TaskSpec v0.1` 与 `ArtifactMetadata v0.1`
- 输出“现状 vs 目标”契约清单（本 PRD 对应）
- **采集当前基线数据**：成功率、TTD、无人工介入率

### Milestone B（W3-W5：Agent 增强）

- `TaskAgent` 壳层 + Planner/Verifier 最小实现
- Executor 复用 `BrowsingAgent`
- 失败恢复策略库（首批 4 类错误）

### Milestone C（W6-W7：MCP 语义收敛 + 交付标准）

- run/result/artifact 契约统一
- outputSchema 验收落地
- 结果中心最小视图（run + artifacts + 验收结果）

### Milestone D（W8：验证与发布）

- 任务级回归与压测
- 发布门槛审查
- 文档闭环（集成指南 + runbook）

## 11. 前端与 API 适配范围（补充）

- v1 保持现有 `/v1/agent` 入口可用，不做破坏性替换。
- 新增 TaskAgent 入口建议使用 `/v1/tasks`（HTTP）与 `/v1/tasks/:id/events`（SSE），旧端点继续兼容。
- WebUI 最小改造：
  - 新增任务提交表单（TaskSpec 基本字段）
  - 新增任务结果视图（status/progress/result/artifacts/verification）
  - 保留现有 agent 调试视图作为开发模式

## 12. 验收指标（v1）

> 注：目标值以 Milestone A 采集到的基线为参考进行最终冻结。

- 首轮成功率（P0 任务集）>= 80%
- 无人工介入完成率 >= 70%
- TTD（任务交付时长）较基线下降 >= 30%
- 结果可验收率（满足 outputSchema + evidence）>= 95%
- 失败可定位率（明确错误码 + 步骤）>= 95%

## 13. 决策点（采纳修订）

1. **是否 async-only**：否。保留 `sync/async/auto`，Agent 默认 async。
2. **`subscribe_task_run_events` 放 v1 还是 v1.1**：建议 v1.1，v1 继续 polling。
3. **checkpoint/resume 是否 v1 门槛**：否，放 v1.1。
4. **Agent 预算默认值**：初始建议 `maxToolCalls = maxIterations * 2`，以基线测试调优。

## 14. 风险与缓解

- 站点波动导致路径失效：恢复策略 + 模板版本化
- Agent 改造周期偏紧：采用“壳层组合”而非重写
- 无持久化导致重启丢任务：文档显式声明 + v1.1 补齐

---

## 附录 A：MCP 改造规模（结论）

- 小改（1-2 周）：契约对齐、语义收敛、文档化。
- 中改（2-4 周）：Agent 三段式、outputSchema 验收、artifact 元数据。
- 较大改（4-6 周）：持久化 + checkpoint/resume（v1.1）。

结论：v1 以“小改 + 中改”为主，技术可行。
