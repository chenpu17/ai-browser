# 无 LLM 产品能力 PRD v0.1

> 状态：Draft
> 适用范围：AI Browser 的 MCP 服务（stdio + SSE）
> 版本目标：在不依赖 LLM 的前提下，把“工具集合”升级为“任务执行产品”

## 1. 背景与目标

当前 MCP 已具备丰富底层工具能力（导航、语义提取、操作、标签页管理等），但用户仍需手工编排工具调用：
- 学习成本高：用户需要理解工具粒度和调用顺序。
- 稳定性门槛高：不同站点的等待、重试、失败恢复逻辑需重复实现。

本阶段目标：
- 将能力中心从“单次工具调用”切换为“可复用任务模板”。
- 提供确定性执行（状态机 + 重试 + 超时 + 结构化产物）。
- 支持无 LLM 的稳定自动化场景，作为后续智能层的稳定底座。

## 2. 产品定位（本阶段）

- 核心定位：**Browser Automation Runtime for MCP**（面向开发者与自动化工程场景）。
- 价值主张：**无需 LLM，仍可完成稳定、可审计、可复现的网页任务执行**。
- **v0.1 首要消费者**：LLM Agent — 通过 MCP 调用模板（一次 `run_task_template` 工具调用完成原本 5-8 次底层工具编排），显著降低 Agent 的调用轮次与出错概率。
- **次要消费者**：集成工程师 — 直接调用 MCP 工具完成自动化集成。
- 交付形式：
  - 模板化任务能力
  - 任务运行时（run）
  - 结构化结果与可追踪日志

### 2.1 与现有 Agent 层的边界

- 模板运行时：确定性编排（规则、状态机、可复现）。
- Agent 层：LLM 驱动编排（开放式决策、探索式执行）。
- 共享关系：两者共享 `SessionManager` 与 MCP 工具层，不重复造浏览器控制能力。
- 组合模式（后续）：允许 Agent 调用模板，将模板作为高阶原子能力。

## 3. 非目标（v0.1 不做）

- 不做自然语言任务理解。
- 不做策略型 AI 决策（例如自动规划下一步）。
- 不做多租户计费/组织管理。
- 不做复杂权限系统重构（仅定义模板执行对 `trustLevel`（`local` / `remote`）的继承原则）。

## 4. 目标用户与核心场景

### 4.1 目标用户

- **LLM Agent（首要）**：通过 `run_task_template` 一次调用完成批量采集等复合任务，替代多轮底层工具编排。
- 集成工程师（次要）：需要把浏览器能力接入现有流程（ETL、监控、业务自动化）。
- 测试/QA 工程师（次要）：需要稳定可复现的网页操作与采集。
- 小团队自动化负责人（次要）：希望通过 MCP 统一任务协议，不依赖某个特定 Agent。

### 4.2 核心场景

1. 登录并保持会话后，执行固定页面巡检。
2. 批量访问 URL 列表并提取结构化信息。
3. 多标签页并行采集并汇总差异。

## 5. 核心能力范围

### P0-A（最小可交付 — v0.1）

- `batch_extract_pages` 模板实现（sync + async 双模式）。
- 3 个 MCP 工具：`list_task_templates`、`run_task_template`、`get_task_run`。
- 前置重构：toolActions 部分提取（6 个工具的核心逻辑从 `browser-mcp-server.ts` 提取为独立函数）。
- 简单 run 状态管理（`Map<string, RunState>` + 状态机）。
- 滑动窗口并发执行。

### P0-B（上线可用 — v0.2）

- `login_keep_session` + `multi_tab_compare` 模板。
- 完整 RunManager（并发控制、超时管理、取消）。
- ArtifactStore + CSV 导出。
- `list_task_runs`、`cancel_task_run`、`get_artifact`、`get_runtime_profile`。
- 模板执行对 trustLevel 的继承与可用性声明。

### P1（增强）

- 定时调度（Cron-like）。
- 批处理并发策略（串行/并行/限流）。
- 断点续跑（从失败步骤恢复）。

### P2（扩展）

- 可视化回放（Timeline Replay）。
- 模板参数 UI 向导。
- 任务版本灰度执行（A/B 配置对比）。

## 6. 能力需求（按用户价值拆解）

### 6.1 模板中心

- 用户价值：减少编排成本，提升复用率。
- 需求：
  - 支持列出内置模板。
  - 支持模板元数据：`id/name/version/inputs/outputs/limits/trustLevelSupport`。
  - 支持模板版本兼容声明。

### 6.2 执行引擎

- 用户价值：保证“同输入同结果行为”可复现。
- 需求：
  - 步骤状态机：`pending/running/succeeded/failed/canceled`。
  - 每步重试策略：次数、退避、是否忽略错误。
  - 全局与步骤超时。

### 6.3 结果产物

- 用户价值：可直接接入业务链路。
- 需求：
  - 标准化 run 输出：`summary + artifacts + metrics`。
  - 支持导出 JSON/CSV/Markdown。
  - 失败时仍产出 partial result。

### 6.4 可观测性

- 用户价值：快速定位失败，便于运维。
- 需求：
  - 运行级指标：总耗时、步骤耗时、成功率。
  - 关键事件日志：步骤开始/结束/重试/失败。
  - 可追踪 runId。

## 7. 模板执行安全边界（原则）

- 模板执行必须继承当前 MCP 连接的 `trustLevel`。
- 模板可声明 `trustLevelSupport`（例如仅 `local` 可用）。
- 模板输入中的敏感字段（如密码）不得写入明文运行日志与持久化产物。
- 细则由 `10-mcp-contract-v0.1.md` 约束。

## 8. 关键用户流程（Happy Path）

1. 客户端发现模板列表。
2. 客户端选择模板并提交参数，创建 run。
3. 运行时按模板步骤执行，实时返回状态。
4. run 完成后获取结构化产物与运行报告。
5. 失败时通过失败步骤与错误码决定重试或修参后重跑。

## 9. 验收指标（v0.1）

### 9.1 指标定义

- 首轮成功率：**单次 run（含模板内置重试）** 达成成功或部分成功的比例。
- TTFR（Time To First Result）：首次获得可用结构化结果片段的时间。
- 指标范围：以 `09-task-templates-v0.1.md` 的模板验收标准为准，PRD 给出整体下限。

### 9.2 基准站点集（固定）

- `tests/fixtures/login.html`
- `tests/fixtures/article.html`
- `tests/fixtures/form.html`
- `tests/fixtures/long-page.html`
- `tests/fixtures/select.html`

### 9.3 目标阈值（v0.1 聚焦 `batch_extract_pages`）

- `batch_extract_pages` 100 URL 批次完整执行率 >= 95%。
- 单 URL 失败不导致 run 崩溃。
- 失败任务中可定位到明确失败步骤比例 >= 95%。
- 结构化结果可被下游直接解析比例 >= 99%。
- TTFR：以首个 URL 产物时间统计。

> 注：`login_keep_session` 与 `multi_tab_compare` 的验收指标移至 P0-B（v0.2）。

## 10. 发布计划

- **Milestone A**（v0.1 — 聚焦 `batch_extract_pages`）：
  - 前置重构：toolActions 部分提取（6 个工具核心逻辑提取为独立函数）
  - `batch_extract_pages` 模板实现（sync + async 双模式）
  - 3 个 MCP 工具：`list_task_templates`、`run_task_template`、`get_task_run`
  - 简单 run 状态管理（Map + 状态机）
  - 滑动窗口并发执行
- **Milestone B**（v0.2 — 模板扩展）：
  - `login_keep_session` + `multi_tab_compare` 模板
  - 完整 RunManager + ArtifactStore + CSV 导出
  - `list_task_runs`、`cancel_task_run`、`get_artifact`、`get_runtime_profile`
- **Milestone C**（运行观测 + 指标接口 + 文档闭环）：不变。

## 11. 依赖与风险

- 依赖：现有 `SessionManager`、MCP 工具集、语义引擎稳定性。
- 风险：不同站点动态加载行为差异导致模板泛化失败。
- 缓解：模板内置 `wait_for_stable` + selector 容错 + 阶段性截图。

## 12. 交付清单

- `09-task-templates-v0.1.md`：任务模板规范与首批模板。
- `10-mcp-contract-v0.1.md`：MCP 契约草案（新增 run/template 接口）。
- `11-observability-runbook-v0.1.md`：运行观测与排障手册（Milestone C 交付）。
