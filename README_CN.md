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

任务型页面：
- `http://localhost:3000/tasks.html` — 提交 TaskAgent 任务
- `http://localhost:3000/task-result.html?taskId=...` — 查看任务状态/结果/事件流

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

先启动 HTTP 服务：

```bash
ai-browser --port 3000
```

SSE 端点：
- `http://127.0.0.1:3000/mcp/sse`

自定义客户端建议直接使用 MCP SDK 的 `SSEClientTransport`（会自动处理 message endpoint）：

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const client = new Client({ name: 'my-client', version: '0.1.0' });
const transport = new SSEClientTransport(new URL('http://127.0.0.1:3000/mcp/sse'));

await client.connect(transport);

const { tools } = await client.listTools();
console.log('tool count:', tools.length);

const created = await client.callTool({ name: 'create_session', arguments: {} });
console.log(created);
```

说明：
- 当前服务暴露的是 legacy HTTP+SSE MCP 传输（`/mcp/sse` + `/mcp/message`）。
- 消息端点是 `POST /mcp/message?sessionId=...`，通常由 transport 内部处理，不建议手工调用。

### 4.1 MCP AI 使用指引

关于 AI 消费策略（`nextActions`、`hasMore/nextCursor`、`topIssues`、细节级别），请参考：
- `docs/18-mcp-ai-consumer-guide-cn.md`
- `docs/19-mcp-ai-readability-roadmap-cn.md`（P0-P2 路线图与执行清单）
- 评测命令：`npm run baseline:v1`（包含 `aiFieldCoverageRate` / `invalidToolCallRate`）

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

当前服务共暴露 **38 个 MCP 工具**：
- **28 个浏览器原子工具**（导航、交互、标签页、日志、上传下载等）
- **3 个复合工具**（多步操作合并为一次调用）
- **7 个任务运行时工具**（模板执行、运行状态、产物读取）

大多数浏览器工具支持可选 `sessionId` — 不传时自动创建/复用默认会话。

面向 AI 使用场景，关键工具响应新增了可选辅助字段：
- `aiSchemaVersion`: AI 辅助字段契约版本
- `aiDetailLevel`: 实际采用的细节级别（`brief` / `normal` / `full`）
- `aiSummary`: 一句话状态摘要，便于快速决策
- `aiMarkdown`: 高信号、分节的紧凑 Markdown
- `aiHints`: 文本形式的下一步建议
- `nextActions`: 结构化下一步建议（`tool`、`args`、`reason`）
- `deltaSummary`: 轮询场景变化摘要（`key`、`changes`）
- `schemaRepairGuidance`: schema 验收失败时的修复导向建议

列表型返回同时统一提供：
- `hasMore` + `nextCursor` 续传语义
- 日志类工具的 `topIssues`（网络/控制台）用于快速故障定位

这些字段均为增量返回，保持向后兼容，不影响原有 JSON 字段。

可通过环境变量 `AI_MARKDOWN_DETAIL_LEVEL=brief|normal|full` 控制返回细节级别（默认 `normal`）。

可选自适应策略（原型）：`AI_MARKDOWN_ADAPTIVE_POLICY=1`
- 轮询类工具会自动偏向 `brief`
- 终态失败场景会自动提升到 `full`

### 会话管理

| 工具 | 说明 |
|------|------|
| `create_session` | 创建新的浏览器会话 |
| `close_session` | 关闭浏览器会话（`force=true` 可关闭 headful 会话） |

### 导航与页面信息

| 工具 | 说明 |
|------|------|
| `navigate` | 打开指定 URL，返回 `statusCode`，慢速页面自动降级超时，检测待处理弹窗 |
| `get_page_info` | 获取页面交互元素及其语义 ID（支持 `maxElements`、`visibleOnly` 参数；敏感字段值自动掩码；包含页面稳定性和弹窗信息） |
| `get_page_content` | 提取页面文本内容，带注意力评分（支持 `maxLength` 截断） |
| `find_element` | 按名称或类型模糊搜索元素 |
| `screenshot` | 页面截图（支持 `fullPage` 全页、`element_id` 元素截图、`format`/`quality` 格式质量） |
| `execute_javascript` | 在页面执行 JavaScript（**仅 local 模式可用**；5 秒超时，结果超过 4000 字符自动截断） |

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
| `wait` | 按条件等待：`time`、`selector`、`networkidle` 或 `element_hidden` |

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
| `upload_file` | 上传文件到 file input 元素（**仅 local 模式可用**） |
| `get_downloads` | 获取已下载文件列表 |

### 复合工具（减少调用次数）

| 工具 | 说明 |
|------|------|
| `fill_form` | 一次填写多个表单字段并可选提交（输入 `fields: [{ element_id, value }]`，可选 `submit`） |
| `click_and_wait` | 点击元素后自动等待页面稳定或导航完成（输入 `element_id` + `waitFor: 'stable'\|'navigation'\|'selector'`） |
| `navigate_and_extract` | 导航到 URL 后立即提取内容（输入 `url` + `extract: 'content'\|'elements'\|'both'`） |

### 任务运行时（无 LLM 模板）

| 工具 | 说明 |
|------|------|
| `list_task_templates` | 列出可用的确定性任务模板 |
| `run_task_template` | 以 `sync` / `async` / `auto` 模式运行模板 |
| `get_task_run` | 查询运行状态、进度、结果和产物引用 |
| `list_task_runs` | 按条件分页查询运行记录（`status`、`templateId`） |
| `cancel_task_run` | 取消运行中的任务 |
| `get_artifact` | 按分片读取任务产物（`offset`、`limit`） |
| `get_runtime_profile` | 获取运行时限制和配置概要 |

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
| `TEMPLATE_NOT_FOUND` | 任务模板不存在 |
| `TRUST_LEVEL_NOT_ALLOWED` | 当前 trust level 不允许运行该模板 |
| `RUN_NOT_FOUND` | 任务运行 ID 不存在 |
| `RUN_TIMEOUT` | 任务运行超时 |
| `RUN_CANCELED` | 任务被客户端取消 |
| `ARTIFACT_NOT_FOUND` | 产物不存在或已过期 |

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
| `POST` | `/v1/tasks` | 提交 TaskAgent 任务 |
| `GET` | `/v1/tasks/:taskId` | 查询任务状态与结果 |
| `GET` | `/v1/tasks/:taskId/events` | 任务事件 SSE 流 |
| `GET` | `/mcp/sse` | SSE MCP 连接 |
| `POST` | `/mcp/message` | SSE MCP 消息端点 |


## Task API 快速开始

提交任务：

```bash
curl -sX POST http://127.0.0.1:3000/v1/tasks \
  -H 'content-type: application/json' \
  -d '{
    "goal": "批量提取页面摘要",
    "inputs": { "urls": ["https://example.com"] },
    "constraints": { "maxDurationMs": 30000, "maxSteps": 20 },
    "budget": { "maxRetries": 1, "maxToolCalls": 120 }
  }'
```

然后通过 `taskId` 轮询状态（`GET /v1/tasks/:taskId`）或订阅 SSE 事件流（`GET /v1/tasks/:taskId/events`）。

## Headless / Headful 模式

默认以 headless 模式运行浏览器。如需使用 headful 模式（例如手动登录）：

- **命令行**: `HEADLESS=false ai-browser`
- **Agent UI**: 在 Settings 中取消勾选 "Headless Mode"
- **API**: `POST /v1/sessions`，请求体 `{ "options": { "headless": false } }`

Cookie 通过内置存储在会话间共享，因此可以先用 headful 会话手动登录，再创建 headless 会话复用登录状态。

## 安全

AI Browser 使用**信任级别**系统来控制不同入口的安全策略。

### 信任级别

| 级别 | 入口 | 说明 |
|------|------|------|
| `local` | stdio MCP (`ai-browser-mcp`)、Agent API、Task API（`/v1/tasks`） | 完全访问 — 允许 `file:` 协议，不阻止私网 IP |
| `remote` | SSE MCP (`/mcp/sse`) | 受限模式 — 阻止私网/回环 IP、DNS 重绑定防护、禁用 `upload_file` 和 `execute_javascript` |

### SSE 端点限制（remote 模式）

- **私网 IP 拦截**：禁止导航到 `localhost`、`127.0.0.1`、`10.x.x.x`、`192.168.x.x` 等 RFC 1918 地址
- **DNS 重绑定防护**：通过异步 DNS 解析检查，阻止解析到私网 IP 的域名
- **工具门控**：禁用 `upload_file` 和 `execute_javascript`，防止本地文件访问和任意代码执行
- **会话清理**：SSE 连接断开时，自动关闭该连接创建的 headless 会话（headful 会话保留）

### Cookie 隔离

AI Browser 设计为**单用户本地工具**，所有会话共享同一个 Cookie 存储。多用户部署需为每个用户运行独立实例。

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
npm run dev         # 开发服务（热重载）
npm run build       # 编译 TypeScript
npm test            # 运行测试
npm run test:run    # 单次运行测试
npm run baseline:v1 # 采集 v1 基线报告
npm run benchmark:v1:expanded # 运行扩展可读性场景评测（P2 原型）
npm run stress:v1   # 执行 100 任务压测报告
```

## 许可证

MIT