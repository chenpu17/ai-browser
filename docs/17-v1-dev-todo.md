# v1 开发任务总清单（TODO）

> 状态：本轮交付完成（进入持续优化）
> 目标：按 v1 规划持续推进，直至里程碑任务全部闭环
> 关联：`docs/13-intelligent-browser-terminal-prd-v1-draft.md`、`docs/14-v1-mcp-contract-v1.md`、`docs/15-v1-agent-implementation-plan.md`、`docs/16-v1-kickoff-plan.md`

## Milestone A（W1-W2）设计与基线

- [x] PRD / MCP 契约 / Agent 实施计划冻结到可开发状态
- [x] 新增 TaskAgent 骨架与基础单测
- [x] 任务级基线采集脚本（成功率/TTD/无人工介入率）
- [x] 基线报告（JSON + Markdown）

## Milestone B（W3）壳层 + Verifier

- [x] TaskAgent 主循环（plan -> execute -> verify -> repair）
- [x] outputSchema 程序化校验
- [x] repair 钩子接口
- [x] 预算控制接入（maxToolCalls 计数硬限制）

## Milestone C（W4）Planner + 恢复策略

- [x] 规则优先 Planner（template-first）
- [x] 未命中时降级 `agent_goal`
- [x] `planner.repair` 基础实现
- [x] 规则映射配置化（从代码常量抽离为配置）
- [x] LLM 兜底分类开关与最小实现

## Milestone D（W5）集成联调

- [x] 新任务入口 API：`POST /v1/tasks`
- [x] 查询 API：`GET /v1/tasks/:id`
- [x] 任务 SSE：`GET /v1/tasks/:id/events`
- [x] 与现有 `/v1/agent` 并行兼容运行

## Milestone E（W6）后端交付能力

- [x] 任务结果对象标准化（summary/result/artifacts/verification）
- [x] traceId 生成与链路传播
- [x] 结构化任务事件（plan_created / task_progress / verification_result / repair_attempted / done）

## Milestone F（W7）前端最小页

- [x] 任务提交页面（TaskSpec 基本字段）
- [x] 任务结果页面（状态 + 验收 + 产物）
- [x] `/v1/tasks` 端到端联调

## Milestone G（W8）回归发布

- [x] 任务级回归用例 >= 10
- [x] 压测 runs >= 100
- [x] 发布门槛检查（指标达标）

## 质量保障（持续）

- [x] 单测：TaskAgent 规则映射/补救/校验
- [x] 集成测试：Task API 最小链路
- [x] 契约测试：run_task_template/get_task_run/list_task_runs/get_artifact
- [x] 回归：现有 BrowsingAgent 与 7 个 task tools 不回退

## 当前迭代（正在执行）

1. 实现 `/v1/tasks` 三个后端接口 ✅
2. 打通 traceId 到任务事件 ✅
3. 增补 API + TaskAgent 关键测试 ✅
4. 基线采集脚本与报告落地 ✅
5. 全量回归测试（152 tests）通过 ✅
6. 任务最小前端页（`/tasks.html`、`/task-result.html`）完成 ✅
7. 100-run 压测完成（成功率 100.0%，P95 1270ms）✅

## Post-v1：MCP 面向 AI 可读性优化（P0-P2）

> 详细路线图：`docs/19-mcp-ai-readability-roadmap-cn.md`

### P0（基础固化）

- [x] MCP 关键工具统一补充 AI 辅助字段（`aiSummary` / `aiMarkdown` / `nextActions`）
- [x] 列表/日志工具统一续传语义（`hasMore` / `nextCursor`）
- [x] network/console 返回 `topIssues`
- [x] 文档与消费指南（README + docs/18）

### P1（决策质量提升）

- [x] 列表/日志工具 stop/continue 信号增强（nextCursor 感知）
- [x] `nextActions` 质量校准（reason/priority 一致化）
- [x] `brief` 模式内容压缩与高信号优先顺序固化
- [x] 基线脚本增加“无效工具调用率”与“辅助字段采用率”统计
- [x] 补充轮询与修复链路的消费示例

### P2（自适应与增量摘要）

- [x] 自适应 detail-level 策略（按任务阶段调整）
- [x] 轮询结果 delta 摘要（仅返回变化项）
- [x] schema 约束任务的修复导向建议增强
- [x] 扩展评测集（长任务/抖动页面/部分成功恢复）
