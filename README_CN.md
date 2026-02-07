# AI Browser

专为 AI Agent 设计的浏览器自动化服务。通过语义分析提取网页结构化信息，并通过 MCP（Model Context Protocol）协议暴露浏览器工具，让 LLM Agent 能够高效地浏览和操作网页。

[English](./README.md)

## 安装

```bash
npm install -g ai-browser
```

安装后提供两个命令：

| 命令 | 说明 |
|------|------|
| `ai-browser` | 启动 HTTP 服务（Web UI + REST API + SSE MCP 端点） |
| `ai-browser-mcp` | 启动 stdio MCP 服务，供 Claude Desktop / Cursor 等调用 |

## 快速开始

### 1. 启动服务

```bash
ai-browser
# 指定端口
ai-browser --port 8080
```

打开 `http://localhost:3000`，主页提供语义分析演示，并可跳转到内置测试 Agent。

### 2. 配置测试 Agent

在 Agent 页面点击 **Settings**，设置 LLM API Key、Base URL 和模型名称。支持任何 OpenAI 兼容的 API。

### 3. 接入 Claude Desktop（stdio MCP）

在 `claude_desktop_config.json` 中添加：

```json
{
  "mcpServers": {
    "ai-browser": {
      "command": "ai-browser-mcp"
    }
  }
}
```

### 4. 远程 MCP 客户端接入（SSE）

```bash
ai-browser --port 3000
# SSE 端点: http://localhost:3000/mcp/sse
# 消息端点: http://localhost:3000/mcp/message?sessionId=xxx
```

### 5. 作为库使用

```typescript
import {
  createBrowserMcpServer,
  BrowserManager,
  SessionManager,
  BrowsingAgent,
} from 'ai-browser';
```

## 功能特性

- **语义化网页分析** — 基于 Chrome 无障碍树（Accessibility Tree）提取页面交互元素（按钮、链接、输入框等），为每个元素分配唯一语义 ID
- **MCP 协议支持** — 通过 MCP 协议暴露浏览器工具，支持 stdio 和 SSE 两种传输方式
- **LLM 驱动的 Agent** — 内置自主浏览 Agent，通过 LLM 工具调用驱动
- **Headless / Headful 切换** — 支持 headful 模式手动登录，再切换到 headless 自动化，Cookie 跨会话共享
- **实时监控** — Web UI 通过 SSE 实时展示 Agent 的操作过程和结果
- **多会话 & 多标签页** — 支持并发浏览器会话，每个会话最多 20 个标签页，过期自动清理

## 架构

```
┌──────────────────────────────────────────────────────────┐
│                       AI Browser                          │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  CLI 层 (src/cli/)                                       │
│    ai-browser ──→ Fastify HTTP + SSE MCP                 │
│    ai-browser-mcp ──→ stdio MCP                          │
│                                                          │
│  API 层 (src/api/)                                       │
│    REST API (/v1/sessions, /v1/agent, ...)               │
│    SSE MCP  (/mcp/sse, /mcp/message)                     │
│                                                          │
│  MCP 层 (src/mcp/)                                       │
│    浏览器工具: navigate, click, type, scroll, ...         │
│                                                          │
│  Agent 层 (src/agent/)                                   │
│    LLM 驱动的 Agent 循环与工具调用                         │
│                                                          │
│  语义层 (src/semantic/)                                   │
│    无障碍树分析、内容提取                                  │
│    元素匹配、页面分类                                     │
│                                                          │
│  浏览器层 (src/browser/)                                  │
│    Puppeteer（headless + headful 双实例）                  │
│    会话 & 标签页管理、Cookie 存储                          │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

## MCP 工具

LLM Agent 可通过 MCP 协议调用以下浏览器工具：

| 工具 | 说明 |
|------|------|
| `navigate` | 打开指定 URL，慢速页面自动降级超时 |
| `get_page_info` | 获取页面交互元素及其语义 ID |
| `get_page_content` | 提取页面文本内容（带注意力评分） |
| `find_element` | 按名称或类型模糊搜索元素 |
| `click` | 通过语义 ID 点击元素 |
| `type_text` | 向输入框输入文本，可选回车提交 |
| `press_key` | 模拟键盘按键（Enter、Escape、Tab 等） |
| `scroll` | 页面上下滚动 |
| `go_back` | 浏览器后退 |
| `wait` | 等待页面加载 |

## REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `POST` | `/v1/sessions` | 创建浏览器会话 |
| `GET` | `/v1/sessions/:id` | 获取会话详情 |
| `DELETE` | `/v1/sessions/:id` | 关闭会话 |
| `POST` | `/v1/sessions/:id/navigate` | 导航到指定 URL |
| `GET` | `/v1/sessions/:id/semantic` | 获取语义元素 |
| `POST` | `/v1/sessions/:id/action` | 执行浏览器操作 |
| `GET` | `/v1/sessions/:id/screenshot` | 截图 |
| `GET` | `/v1/sessions/:id/content` | 提取页面内容 |
| `POST` | `/v1/sessions/:id/tabs` | 创建新标签页 |
| `GET` | `/v1/sessions/:id/tabs` | 列出所有标签页 |
| `POST` | `/v1/agent/run` | 启动 Agent 任务 |
| `GET` | `/v1/agent/:id/events` | Agent 事件 SSE 流 |
| `GET` | `/mcp/sse` | SSE MCP 连接 |
| `POST` | `/mcp/message` | SSE MCP 消息端点 |

## Headless / Headful 模式

默认以 headless 模式运行浏览器。如需使用 headful 模式（例如手动登录）：

- **命令行**: `HEADLESS=false ai-browser`
- **Agent UI**: 在 Settings 中取消勾选 "Headless Mode"
- **API**: `POST /v1/sessions`，请求体 `{ "options": { "headless": false } }`

Cookie 通过内置存储在会话间共享，因此可以先用 headful 会话手动登录，再创建 headless 会话复用登录状态。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | HTTP 服务端口 | `3000` |
| `HOST` | HTTP 服务监听地址 | `127.0.0.1` |
| `HEADLESS` | 设为 `false` 启用 headful 模式 | `true` |
| `CHROME_PATH` | 自定义 Chrome/Chromium 路径 | 自动检测 |
| `PROXY_SERVER` | 浏览器 HTTP 代理 | — |
| `LLM_API_KEY` | LLM API Key（内置 Agent 使用） | — |
| `LLM_BASE_URL` | LLM API Base URL | — |
| `LLM_MODEL` | LLM 模型名称 | — |

## 开发

```bash
git clone https://github.com/chenpu17/ai-browser.git
cd ai-browser
npm install
npm run dev      # 开发服务（热重载）
npm run build    # 编译 TypeScript
npm test         # 运行测试
npm run test:run # 单次运行测试
```

## 许可证

MIT