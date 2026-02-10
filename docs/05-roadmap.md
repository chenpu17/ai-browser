# 实现路线图

## 阶段划分

### Phase 1: 基础框架 ✅ 已完成

**目标**: 搭建基础架构，实现最小可用版本

**交付物**:
- 项目脚手架（TypeScript + Node.js）
- Puppeteer 浏览器控制层
- 基础 API 服务（Fastify）
- 简单的元素索引

### Phase 2: 语义引擎 ✅ 已完成

**目标**: 实现核心语义分析能力

**交付物**:
- 页面类型识别器
- 元素语义 ID 生成
- 状态追踪器
- 智能等待机制

### Phase 3: 操作增强 ✅ 已完成

**目标**: 完善操作能力和错误处理

**交付物**:
- 模糊元素匹配
- 操作结果反馈
- 错误恢复机制
- iframe 处理

### Phase 4: 扩展能力 ✅ 已完成

**目标**: 支持更多场景和协议扩展

**交付物**:
- 内容提取器（带注意力评分）
- MCP Server（stdio + SSE 双传输）
- LLM 驱动的自主浏览 Agent
- 多会话 & 多标签页管理
- Headless / Headful 双实例切换
- Cookie 跨会话共享
- npm 包发布（`ai-browser` CLI 命令）
- Web UI（语义分析演示 + Agent 测试页面）

### Phase 5: 无 LLM 产品化（进行中）

**目标**: 从“工具集合”升级为“模板化任务执行产品”

**交付物（规划）**:
- 无 LLM 产品能力 PRD（`08-non-llm-prd-v0.1.md`）
- 首批任务模板规范（`09-task-templates-v0.1.md`）
- MCP 任务契约草案（`10-mcp-contract-v0.1.md`）
- 运行观测与排障手册（`11-observability-runbook-v0.1.md`）
- 模板运行时（run/query + sync/async 双模式）
- 模板执行 trustLevel 继承策略
- 模板运行时集成测试（成功/失败/部分成功）

**里程碑状态**:

- **Milestone A**（v0.1 — 聚焦 `batch_extract_pages`）：✅ 已完成
  - 前置重构：toolActions 部分提取（6 个工具的核心逻辑从 `browser-mcp-server.ts` 提取为独立函数：`navigate`、`wait_for_stable`、`get_page_info`、`get_page_content`、`create_tab`、`close_tab`）
  - `batch_extract_pages` 模板实现（sync + async 双模式）
  - 3 个 MCP 工具：`list_task_templates`、`run_task_template`、`get_task_run`
  - 简单 run 状态管理（`Map<string, RunState>` + 状态机，不需要完整 RunManager）
  - 滑动窗口并发执行

- **Milestone B**（v0.2 — 模板扩展）：🟡 进行中
  - `login_keep_session` + `multi_tab_compare` 模板（已实现）
  - 完整 RunManager（并发控制、超时管理、协作式取消）（已实现）
  - ArtifactStore（JSON 分片读取已实现，CSV 导出待补）
  - `list_task_runs`、`cancel_task_run`、`get_artifact`、`get_runtime_profile`（已实现）

- **Milestone C**（运行观测 + 指标接口 + 文档闭环）：⚪ 未开始
  - 运行级指标（总耗时、步骤耗时、成功率）
  - 关键事件日志（步骤开始/结束/重试/失败）
  - 运行观测与排障手册（`11-observability-runbook-v0.1.md`）

## 技术栈

| 层级 | 技术选型 | 说明 |
|------|----------|------|
| 语言 | TypeScript | 类型安全 |
| 运行时 | Node.js | 生态丰富 |
| 浏览器 | Puppeteer | 基于 CDP 的高层封装 |
| API | Fastify | 高性能 HTTP |
| 测试 | Vitest | 快速单测 |
| MCP | @modelcontextprotocol/sdk | MCP 协议实现（stdio + SSE） |

说明：使用 Puppeteer 作为浏览器控制层，底层通过 CDP 与 Chromium 通信。MCP 协议通过官方 SDK 实现，支持 stdio 和 SSE 两种传输方式。
