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
