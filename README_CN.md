# AI Browser

基于 LLM 驱动的智能浏览器自动化服务，通过语义分析和 MCP（Model Context Protocol）协议，让 AI Agent 能够自主浏览和操作网页。

[English](./README.md)

## 特性

- **语义化网页分析** — 基于 Chrome 无障碍树提取页面结构化元素（按钮、链接、输入框），为每个元素分配唯一语义 ID，实现可靠交互
- **LLM 驱动的 Agent** — 自主浏览 Agent，通过 LLM 工具调用完成导航、搜索、表单填写、信息提取等任务
- **MCP 协议集成** — 浏览器工具通过 MCP 协议暴露，实现 Agent 与浏览器的标准化通信
- **实时监控** — Web UI 通过 SSE 实时展示 Agent 的操作步骤、工具调用和结果
- **多会话支持** — 支持并发浏览器会话，多标签页管理，自动清理过期会话

## 架构

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Web UI    │────▶│  Fastify API │────▶│  Browsing Agent  │
│  (SSE)      │     │  (REST)      │     │  (LLM Loop)      │
└─────────────┘     └──────────────┘     └────────┬─────────┘
                                                   │ MCP
                                          ┌────────▼─────────┐
                                          │  MCP Server       │
                                          │  (浏览器工具)      │
                                          └────────┬─────────┘
                                                   │
                                          ┌────────▼─────────┐
                                          │  Puppeteer        │
                                          │  + 语义分析层      │
                                          └──────────────────┘
```

- **浏览器层** (`src/browser/`) — 基于 Puppeteer 的浏览器管理，支持多标签页会话
- **语义层** (`src/semantic/`) — 无障碍树分析、内容提取、元素匹配、页面分类
- **MCP 层** (`src/mcp/`) — MCP Server，暴露浏览器工具（导航、点击、输入、滚动等）
- **Agent 层** (`src/agent/`) — LLM 驱动的 Agent 循环，支持工具调用、循环检测、步数管理
- **API 层** (`src/api/`) — Fastify HTTP 服务，提供 REST 接口和 SSE 事件流

## 快速开始

### 环境要求

- Node.js >= 18
- OpenAI 兼容的 LLM API

### 安装

```bash
git clone https://github.com/chenpu17/ai-browser.git
cd ai-browser
npm install
```

### 配置

设置环境变量：

```bash
export LLM_API_KEY="your-api-key"
export LLM_BASE_URL="https://api.openai.com/v1"  # 或任何 OpenAI 兼容的接口
export LLM_MODEL="gpt-4"                          # 模型名称
export PROXY_SERVER="127.0.0.1:7897"               # 可选，浏览器 HTTP 代理
```

### 启动

```bash
# 开发模式
npm run dev

# 或直接指定环境变量
LLM_API_KEY=your-key npx tsx src/index.ts
```

打开 `http://localhost:3000` 访问 Web UI。

## MCP 工具

Agent 通过 MCP 协议使用以下浏览器工具：

| 工具 | 说明 |
|------|------|
| `navigate` | 打开 URL，慢速页面自动降级（超时后仍可操作已加载部分） |
| `get_page_info` | 获取页面可交互元素（按钮、链接、输入框），每个元素带语义 ID |
| `get_page_content` | 提取页面文本内容（标题、正文、链接、元数据） |
| `find_element` | 模糊搜索元素，支持中英文类型别名（如"搜索框"匹配 textbox） |
| `click` | 通过语义 ID 点击元素 |
| `type_text` | 输入文本，可选 `submit=true` 自动按回车提交 |
| `press_key` | 按键盘按键（Enter、Escape、Tab 等） |
| `scroll` | 上下滚动页面 |
| `go_back` | 返回上一页 |
| `wait` | 等待页面加载 |

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `POST` | `/v1/sessions` | 创建浏览器会话 |
| `GET` | `/v1/sessions/:id/semantic` | 获取语义化元素 |
| `POST` | `/v1/sessions/:id/action` | 执行浏览器操作 |
| `GET` | `/v1/sessions/:id/screenshot` | 截取页面截图 |
| `POST` | `/v1/agent/run` | 启动 Agent 任务 |
| `GET` | `/v1/agent/:id/events` | SSE 事件流 |

## 开发

```bash
npm run build    # 编译 TypeScript
npm run dev      # 开发模式（热重载）
npm test         # 运行测试
npm run test:run # 单次运行测试
```

## 测试

项目包含 20 个真实网站浏览场景的测试套件：

```bash
node tests/run-scenarios.mjs
```

覆盖场景包括：搜索引擎、新闻网站、技术文档、电商网站等。

## 许可证

MIT
