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

LLM Agent 可通过 MCP 协议调用以下 28 个浏览器工具。所有工具的 `sessionId` 参数均为可选 — 不传时自动创建/复用默认会话。

### 会话管理

| 工具 | 说明 |
|------|------|
| `create_session` | 创建新的浏览器会话 |
| `close_session` | 关闭浏览器会话 |

### 导航与页面信息

| 工具 | 说明 |
|------|------|
| `navigate` | 打开指定 URL，返回 `statusCode`，慢速页面自动降级超时，检测待处理弹窗 |
| `get_page_info` | 获取页面交互元素及其语义 ID（支持 `maxElements`、`visibleOnly` 参数；敏感字段值自动掩码；包含页面稳定性和弹窗信息） |
| `get_page_content` | 提取页面文本内容，带注意力评分（支持 `maxLength` 截断） |
| `find_element` | 按名称或类型模糊搜索元素 |
| `screenshot` | 页面截图（支持 `fullPage` 全页、`element_id` 元素截图、`format`/`quality` 格式质量） |
| `execute_javascript` | 在页面执行 JavaScript（5 秒超时，结果超过 4000 字符自动截断） |

### 元素交互

| 工具 | 说明 |
|------|------|
| `click` | 通过语义 ID 点击元素（自动捕获弹出窗口为新标签页） |
| `type_text` | 向输入框输入文本，可选回车提交 |
| `hover` | 悬停在元素上，触发 tooltip / 下拉菜单 |
| `select_option` | 通过值选择下拉选项 |
| `set_value` | 直接设置元素值（适用于富文本编辑器、contenteditable 等场景） |
| `press_key` | 模拟键盘按键（Enter、Escape、Tab 等），支持组合键（`modifiers: ['Control']`） |
| `scroll` | 页面上下滚动 |
| `go_back` | 浏览器后退 |
| `wait` | 等待条件：`time`、`selector`、`networkidle` 或 `element_hidden` |

### 标签页管理

| 工具 | 说明 |
|------|------|
| `create_tab` | 创建新标签页（自动切换，可选 URL） |
| `list_tabs` | 列出会话中所有标签页 |
| `switch_tab` | 切换到指定标签页 |
| `close_tab` | 关闭指定标签页 |

### 弹窗处理

| 工具 | 说明 |
|------|------|
| `handle_dialog` | 处理页面弹窗 — 接受或关闭 alert、confirm、prompt |
| `get_dialog_info` | 获取待处理弹窗信息和弹窗历史 |

### 页面监控

| 工具 | 说明 |
|------|------|
| `wait_for_stable` | 等待 DOM 稳定（无 DOM 变更 + 无待处理网络请求） |
| `get_network_logs` | 获取网络请求日志（支持 `xhr`、`failed`、`slow`、`urlPattern` 过滤） |
| `get_console_logs` | 获取控制台日志（按级别过滤，默认返回 error + warn） |

### 文件处理

| 工具 | 说明 |
|------|------|
| `upload_file` | 上传文件到 file input 元素 |
| `get_downloads` | 获取已下载文件列表 |

### 结构化错误码

错误响应包含 `errorCode` 字段，便于程序化处理：

| 错误码 | 含义 |
|--------|------|
| `ELEMENT_NOT_FOUND` | 元素不存在，响应包含 `hint` 提示刷新页面信息 |
| `NAVIGATION_TIMEOUT` | 页面加载超时，可重试 |
| `SESSION_NOT_FOUND` | 会话不存在 |
| `PAGE_CRASHED` | 页面崩溃或已关闭 |
| `INVALID_PARAMETER` | 参数值无效 |
| `EXECUTION_ERROR` | JavaScript 执行错误 |

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