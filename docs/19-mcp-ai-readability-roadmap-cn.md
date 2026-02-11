# MCP 面向 AI 可读性优化路线图（P0–P2）

> 状态：进行中
> 负责人：MCP + Agent 团队
> 更新时间：2026-02-11
> 关联文档：`docs/14-v1-mcp-contract-v1.md`、`docs/15-v1-agent-implementation-plan.md`、`docs/18-mcp-ai-consumer-guide-cn.md`

## 1）目标

持续优化 MCP 工具返回，让 AI Agent 能够：

- 以更少重试做出正确下一步决策；
- 用更低上下文成本完成同等任务；
- 在部分失败场景下进行可解释、可恢复的执行。

## 2）效果指标

- **首个动作正确率**：>= 85%（基线任务集）
- **无效工具调用率**：<= 5%
- **非终态问题后的恢复成功率**：>= 70%
- **AI 辅助字段 token 开销**：`normal` 模式 <= 20%
- **向后兼容**：既有字段 0 破坏

## 3）优先级计划

### P0 — 基础能力固化（已完成 / 稳定化）

### 范围

- 在关键工具返回中增加 AI 辅助字段（增量不破坏）：
  - `aiSchemaVersion`、`aiDetailLevel`、`aiSummary`、`aiMarkdown`、`aiHints`、`nextActions`
- 统一续传语义：
  - `hasMore` + `nextCursor`
- 日志快速诊断：
  - `topIssues`（network/console）
- 任务运行可解释性：
  - `resultSummary`、`evidenceRefs`
- 意图对齐建议：
  - `recommendedByIntent`（`get_page_info`）
- 可配置返回细节：
  - `AI_MARKDOWN_DETAIL_LEVEL=brief|normal|full`

### 交付

- `src/mcp/ai-markdown.ts`
- browser/task 工具层的统一接入
- 回归测试 + formatter 单测
- AI 使用指引文档（中/英）

### 出口标准

- 构建通过
- 非浏览器依赖测试通过
- 不引入契约破坏

### P1 — 决策质量提升（进行中）

### 范围

1. **可执行建议质量标准化**
   - 统一 `nextActions` 的 reason 与 priority 质量
   - 为列表/日志/任务状态工具补强停止/继续信号
2. **高信号压缩**
   - `brief` 模式减少重复段落
   - 固定“状态/结果/阻塞”优先顺序
3. **消费侧 Prompt 对齐**
   - 内置 Agent prompt 更明确采用 `nextActions` first
   - 补充外部 MCP 客户端接入示例
4. **可观测性补强**
   - 在基线脚本中统计 AI 辅助字段采用情况
   - 报告中输出可读性质量说明

### 交付

- `src/mcp/ai-markdown.ts` 的格式优化
- `src/agent/prompt.ts` 对齐更新
- 基线脚本与报告增强
- README / 指引文档同步

### 出口标准

- 相对 P0 基线，无效工具调用率下降 >= 15%
- 任务成功率不回退

### P2 — 自适应智能层（计划中）

### 范围

1. **自适应返回策略**
   - 按阶段（规划/执行/恢复）动态调节细节级别
   - 为高频轮询工具提供更紧凑模式
2. **增量变化摘要（Delta）**
   - 重复轮询时输出“仅变化项”摘要
3. **Schema 感知提示**
   - 对 schema 约束任务输出更强的 mismatch 修复建议
4. **评测集扩展**
   - 新增长任务、易抖动页面、部分成功恢复场景

### 交付

- 自适应 formatter 能力
- 轮询场景 delta 摘要原型
- 评测脚本/模板扩展
- 契约文档新增字段说明（保持增量）

### 出口标准

- 相对 P1，恢复成功率提升 >= 10%
- `normal` 模式 token 开销维持预算内

## 4）里程碑排期

- **W1（P0 稳定化）**：回归、测试、文档固化
- **W2-W3（P1）**：建议质量 + 压缩 + prompt 对齐 + 基线对比
- **W4+（P2）**：自适应 + delta + 评测集扩展

## 5）风险与应对

- **风险**：字段过多导致 token 开销上升
  - **应对**：严格 detail-level 策略 + token 预算门禁
- **风险**：不同工具输出风格漂移
  - **应对**：共享 formatter + 分类回归测试
- **风险**：调用方过度依赖辅助字段忽略原始字段
  - **应对**：文档明确“原始字段为最终事实来源”

## 6）执行清单

- [x] P0 辅助字段 + 续传语义 + topIssues + 文档
- [x] P0 formatter 与回归测试
- [x] P1 列表/日志工具的 stop/continue 信号增强（nextCursor 感知）
- [x] P1 `nextActions` 质量校准
- [x] P1 基线指标与报告扩展
- [x] P1 `brief` 模式压缩并固化状态/结果/阻塞顺序
- [x] P1 补充轮询/修复链路示例
- [x] P2 自适应 detail 策略原型
- [x] P2 轮询 delta 摘要原型
- [x] P2 schema 约束任务修复导向建议增强
- [x] P2 扩展场景评测

