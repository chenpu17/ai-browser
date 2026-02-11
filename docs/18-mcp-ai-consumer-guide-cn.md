# MCP AI 使用指引

本文说明 Claude Desktop / Cursor / 自定义 MCP 客户端在消费 `ai-browser` 工具结果时，如何更稳定地做决策与编排。

## 1）前置条件

- 启动 MCP 服务：
  - stdio：`ai-browser-mcp`
  - SSE：`ai-browser --port 3000`，连接 `http://127.0.0.1:3000/mcp/sse`
- （可选）配置服务端 AI 细节级别：
  - `AI_MARKDOWN_DETAIL_LEVEL=brief|normal|full`
  - 默认 `normal`
- `AI_MARKDOWN_ADAPTIVE_POLICY=1`（原型）
  - 轮询与失败场景自适应调节细节级别

## 2）AI 增强字段（增量返回）

在原始 JSON 字段之外，工具结果会追加：

- `aiSchemaVersion`：AI 辅助字段版本
- `aiDetailLevel`：实际使用的细节级别
- `aiSummary`：一句话摘要
- `aiMarkdown`：结构化紧凑 Markdown
- `aiHints`：文本型下一步建议
- `nextActions`：结构化下一步建议
- `deltaSummary`：可选轮询变化摘要（`key` + `changes`）
- `schemaRepairGuidance`：schema 验收失败时的结构化修复建议
- 在 `brief` 细节级别下，`aiMarkdown` 固定按 `Status` -> `Result` -> `Blocker` 顺序输出

`nextActions` 示例：

```json
{
  "tool": "get_task_run",
  "args": { "runId": "..." },
  "reason": "轮询任务直到终态",
  "priority": "high"
}
```

## 3）推荐决策顺序

每次工具调用后建议按以下顺序处理：

1. `nextActions` 非空时，优先执行高优先级动作。
2. 否则根据 `aiSummary + aiHints` 决定下一步。
3. 需要更多上下文时再读 `aiMarkdown`。
4. 兜底读取原始字段（始终是最终真值来源）。

## 4）续传语义（列表/日志）

列表类和日志类工具可能返回：

- `hasMore: boolean`
- `nextCursor: object | null`

建议：

- `hasMore=true` 时按 `nextCursor` 继续拉取
- `hasMore=false` 时停止翻页并进入后续动作
- 若返回 `deltaSummary`，先阅读 `changes` 再决定是否下钻全量字段

## 5）日志快速故障定位

`get_network_logs` / `get_console_logs` 额外返回：

- `topIssues`：聚合后的高信号问题

建议：

- 先看 `topIssues` 再下钻原始 `logs`
- 避免直接全量扫描日志，减少 token 与误判

## 6）任务运行时建议

任务相关工具建议流程：

- `run_task_template` 后优先跟随 `nextActions`（通常是 `get_task_run`）
- 到终态后优先看：
  - `resultSummary`（摘要）
  - `evidenceRefs` / `artifactIds`（证据定位）
- 当出现 `schemaRepairGuidance` 时，先按 `missingFields`/`typeMismatches` 补证据再重试

## 7）给 Agent 的 Prompt 建议

建议在系统提示词中加入：

- 有 `nextActions` 时优先使用，不做无约束自由规划
- 用 `aiSummary` 做状态机迁移判断
- 无必要不展开完整 `aiMarkdown`
- 遵循 `hasMore/nextCursor` 续传规则

## 8）兼容性说明

这些 AI 字段均为**增量字段**：

- 不影响旧客户端按原字段工作
- 可渐进式接入 AI 字段，不会破坏现有调用

## 9）路线图

- 关于 P0-P2 可读性优化计划与执行清单，请参考：
  - `docs/19-mcp-ai-readability-roadmap-cn.md`

## 10）评测与基线

可通过以下命令执行基线评测：

```bash
npm run baseline:v1
npm run benchmark:v1:expanded
```

报告新增 AI 可读性指标：
- `aiFieldCoverageRate`（辅助字段覆盖率）
- `invalidToolCallRate`（无效工具调用率）
- `followUpActionSuccessRate`（后续建议动作成功率）
- 扩展场景报告：`docs/reports/v1-expanded-benchmark.md`

## 11）轮询与修复示例

### 示例 A：按 `nextActions` 进行轮询

1. 调用 `run_task_template`
2. 读取最高优先级 `nextActions`（通常是 `get_task_run`）
3. 持续轮询直到任务进入终态（`succeeded` / `failed` / `partial_success` / `canceled`）
4. 若 `nextActions` 给出 `get_artifact`，继续拉取证据分片

### 示例 B：schema 不匹配修复链路

当 `get_task_run` 终态仍存在验收不匹配时：

1. 查看 `verification.missingFields` 与 `verification.typeMismatches`
2. 优先执行 `nextActions` 给出的结构化后续动作
3. 若无结构化动作，再做定向补采（`get_page_info` / `find_element` / `get_page_content`）
4. 结合修正后的输入或 schema 重新发起任务

