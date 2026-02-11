# AI Browser 设计文档

## 项目概述

AI Browser 是一款专为 AI Agent 设计的浏览器，提供结构化的语义输出和语义化的操作接口，让 AI 能够高效地理解和操作网页。

## 安装与使用

```bash
npm install -g ai-browser
```

安装后提供两个命令：

| 命令 | 说明 |
|------|------|
| `ai-browser` | 启动 HTTP 服务（Web UI + REST API + SSE MCP 端点） |
| `ai-browser-mcp` | 启动 stdio MCP 服务，供 Claude Desktop / Cursor 等调用 |

也可作为库导入：

```typescript
import { createBrowserMcpServer, BrowserManager, SessionManager, BrowsingAgent } from 'ai-browser';
```

## 核心问题

现有浏览器是为人类设计的，AI 使用时存在以下痛点：

1. **输出不友好** - 浏览器输出像素/DOM，AI 需要截图+视觉理解或解析复杂 DOM
2. **操作模式低效** - 需要模拟人类的点击、滚动、输入，而非直接调用
3. **状态感知困难** - 页面加载状态、动态内容、异步请求难以准确判断
4. **上下文丢失** - 每次操作后需要重新"理解"整个页面

## 设计目标

### 核心能力

| 能力 | 描述 |
|------|------|
| 语义输出 | 输出结构化的页面语义信息，而非原始 DOM/像素 |
| 语义操作 | 接收语义化指令（如 `click("登录按钮")`），而非坐标/选择器 |
| 状态感知 | 主动追踪并告知页面状态（加载中、就绪、错误等） |
| 智能等待 | 自动判断页面"就绪"，无需固定等待时间 |

### 使用方式

- **调用方**: 外部 AI Agent（通过 MCP 协议或 HTTP API）
- **接入方式**:
  - stdio MCP（Claude Desktop / Cursor 等本地 Agent）
  - SSE MCP（远程 MCP 客户端）
  - HTTP REST API（自定义集成）
  - 库导入（编程使用）
- **场景**: 通用任务（信息读取、表单填写、发送邮件、搜索等）

### 语义理解层次

采用渐进式设计，先实现基础能力，支持扩展：

| 层次 | 描述 | 实现方式 |
|------|------|----------|
| A. 结构化元素 | 可交互元素列表、基础分类 | 规则 |
| B. 页面意图 | 页面类型识别、状态理解 | 规则 + 启发式 |
| C. 深度理解 | 内容语义理解 | 模型（扩展） |

## 与现有方案对比

| 维度 | Playwright 等 | AI Browser |
|------|--------------|------------|
| 输出 | DOM / 截图 | 语义结构 |
| 操作 | CSS选择器 / 坐标 | 语义化指令 |
| 状态 | 需 AI 自行判断 | 主动告知 |
| 等待 | 固定时间 / 条件表达式 | 智能判断 |
| 定位 | 开发者需要 | AI 友好 |

## 文档索引

- [01-architecture.md](./01-architecture.md) - 整体架构设计
- [02-semantic-engine.md](./02-semantic-engine.md) - 语义引擎设计
- [03-api-design.md](./03-api-design.md) - API 接口设计
- [04-data-structures.md](./04-data-structures.md) - 数据结构定义
- [05-roadmap.md](./05-roadmap.md) - 实现路线图
- [06-testing.md](./06-testing.md) - 自动化测试设计
- [07-dev-plan.md](./07-dev-plan.md) - 开发计划（关联设计文档）
- [18-mcp-ai-consumer-guide.md](./18-mcp-ai-consumer-guide.md) - MCP AI Consumer Guide（EN）
- [18-mcp-ai-consumer-guide-cn.md](./18-mcp-ai-consumer-guide-cn.md) - MCP AI 使用指引（ZH）
- [19-mcp-ai-readability-roadmap.md](./19-mcp-ai-readability-roadmap.md) - MCP AI Readability Roadmap（EN）
- [19-mcp-ai-readability-roadmap-cn.md](./19-mcp-ai-readability-roadmap-cn.md) - MCP 面向 AI 可读性优化路线图（ZH）
