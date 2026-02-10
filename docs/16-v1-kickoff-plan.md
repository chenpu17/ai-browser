# v1 开发启动计划（Kickoff）

> 状态：Completed
> 依据：`docs/13-intelligent-browser-terminal-prd-v1-draft.md`、`docs/14-v1-mcp-contract-v1.md`、`docs/15-v1-agent-implementation-plan.md`

## 1. 目标

- 本周完成 Milestone A 的“可执行启动”项。
- 在主干落入 TaskAgent 基础骨架与测试，确保后续迭代可持续。

## 2. 里程碑映射（当前迭代）

- Milestone A（W1-W2）
  - [x] 文档冻结：PRD / MCP 契约 / Agent 实施计划
  - [x] TaskAgent 骨架代码落地（Planner / Verifier / repair 钩子）
  - [x] TaskAgent 基础单测
  - [x] 基线采集脚本与基线数据（成功率/TTD/无人工介入率）
  - [x] `/v1/tasks` API 草案实现（最小可用）

## 3. 当前已启动开发项

- 新增 `TaskAgent`：`src/agent/task-agent.ts`
- 新增单测：`tests/task-agent.test.ts`
- 对外导出：`src/index.ts`

## 4. 下一个开发批次（48 小时）

1. API 接入（最小可用）
   - `POST /v1/tasks`
   - `GET /v1/tasks/:id`
   - `GET /v1/tasks/:id/events`
2. 运行指标与追踪
   - runId/traceId 打通到 TaskAgent 事件
3. 基线采集
   - 固化 10 个任务级样例
   - 输出第一版基线报告（JSON + Markdown）

## 5. 风险与处理

- 风险：TaskAgent fallback 到 agent_goal 需要模型配置
  - 处理：无模型时返回可解释错误，不阻塞模板路径
- 风险：`/v1/tasks` 新入口可能与旧 `/v1/agent` 行为冲突
  - 处理：保持旧接口不变，新接口独立 map 与事件流

## 6. 验收标准（本启动阶段）

- [x] 代码可构建
- [x] TaskAgent 单测通过
- [x] 现有 contract 测试无回归
- [x] 新任务入口最小链路可跑通


## 7. 基线结果（首轮）

- 报告脚本：`npm run baseline:v1`
- 报告文件：`docs/reports/v1-baseline.json`、`docs/reports/v1-baseline.md`
- 当前结果（2026-02-10）：
  - 成功率：100.0%（10/10）
  - 平均 TTD：1068ms
  - 无人工介入率：100.0%

- 压测报告：`docs/reports/v1-stress-100.json`、`docs/reports/v1-stress-100.md`
