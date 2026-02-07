# API 接口设计

## 概述

AI Browser 对外提供 HTTP API，支持页面读取和操作控制。

## API 版本

业务接口使用 `/v1` 前缀：

```
业务接口: /v1/sessions, /v1/...
系统接口: /health, /v1/info (无版本前缀)
```

版本兼容策略：
- 主版本号变更表示不兼容的 API 修改
- 旧版本至少维护 6 个月

## 系统接口

### 健康检查

```
GET /health
```

响应：
```json
{
  "status": "healthy",
  "version": "1.0.0",
  "uptime": 3600
}
```

### 服务信息

```
GET /v1/info
```

响应：
```json
{
  "version": "1.0.0",
  "capabilities": ["semantic", "action", "content"],
  "chromiumVersion": "120.0.0"
}
```

## 错误响应

### 错误格式

```json
{
  "error": {
    "code": "ELEMENT_NOT_FOUND",
    "message": "Element with id 'btn_登录' not found",
    "details": {
      "elementId": "btn_登录"
    }
  }
}
```

### HTTP 状态码

| 状态码 | 含义 |
|--------|------|
| 400 | 请求参数错误 |
| 404 | 会话/元素不存在 |
| 408 | 操作超时 |
| 500 | 内部错误 |
| 503 | 浏览器不可用 |

## 业务接口

### 1. 会话管理

#### 创建会话

```
POST /v1/sessions
```

请求：
```json
{
  "options": {
    "headless": true,
    "viewport": { "width": 1280, "height": 720 },
    "userAgent": "custom-ua",
    "timeout": 3600
  }
}
```

说明：
- `headless`: 设为 `false` 启用 headful 模式（用于手动登录等场景），默认 `true`
- `timeout`: 会话超时时间（秒），默认 3600，超时后自动清理

响应：
```json
{
  "sessionId": "sess_abc123",
  "status": "created"
}
```

#### 关闭会话

```
DELETE /v1/sessions/{sessionId}
```

#### 获取会话详情

```
GET /v1/sessions/{sessionId}
```

响应：
```json
{
  "sessionId": "sess_abc123",
  "status": "active",
  "currentUrl": "https://example.com",
  "createdAt": 1707100000,
  "lastActivityAt": 1707103600,
  "expiresAt": 1707103600
}
```

### 2. 页面导航

#### 打开页面

```
POST /v1/sessions/{sessionId}/navigate
```

请求：
```json
{
  "url": "https://example.com",
  "waitUntil": "ready"
}
```

响应：
```json
{
  "success": true,
  "page": {
    "url": "https://example.com",
    "title": "Example Domain",
    "pageType": "article",
    "state": "ready"
  }
}
```

### 3. 页面读取

#### 获取页面语义

```
GET /v1/sessions/{sessionId}/semantic
```

响应：
```json
{
  "page": {
    "url": "https://mail.example.com/compose",
    "title": "撰写邮件",
    "pageType": "email_compose",
    "summary": "邮件撰写页面，可发送新邮件"
  },
  "intents": [
    {
      "action": "send_email",
      "confidence": 0.95,
      "requiredElements": ["input_收件人", "textarea_正文", "btn_发送"]
    }
  ],
  "elements": [
    {
      "id": "input_收件人",
      "type": "text_input",
      "label": "收件人",
      "actions": ["type", "clear"]
    },
    {
      "id": "input_主题",
      "type": "text_input",
      "label": "主题",
      "actions": ["type", "clear"]
    },
    {
      "id": "textarea_正文",
      "type": "textarea",
      "label": "正文",
      "actions": ["type", "clear"]
    },
    {
      "id": "btn_发送",
      "type": "button",
      "label": "发送",
      "actions": ["click"]
    }
  ],
  "regions": [
    { "id": "header", "type": "header" },
    { "id": "main", "type": "main" }
  ],
  "state": {
    "loadState": "complete",
    "isReady": true
  }
}
```

### 4. 页面操作

#### 执行操作

```
POST /v1/sessions/{sessionId}/action
```

请求：
```json
{
  "action": "type",
  "target": "input_收件人",
  "params": {
    "text": "test@example.com"
  }
}
```

响应：
```json
{
  "success": true,
  "changes": {
    "urlChanged": false,
    "domMutations": 2
  }
}
```

#### 批量操作

```
POST /v1/sessions/{sessionId}/actions
```

请求：
```json
{
  "actions": [
    { "action": "type", "target": "input_收件人", "params": { "text": "test@example.com" } },
    { "action": "type", "target": "input_主题", "params": { "text": "测试邮件" } },
    { "action": "type", "target": "textarea_正文", "params": { "text": "这是正文内容" } },
    { "action": "click", "target": "btn_发送" }
  ]
}
```

### 5. 内容提取

#### 提取页面内容

```
GET /v1/sessions/{sessionId}/content
```

响应：
```json
{
  "content": {
    "title": "文章标题",
    "sections": [
      { "tag": "h1", "text": "文章标题", "attention": 0.82 },
      { "tag": "p", "text": "核心段落内容...", "attention": 0.65 },
      { "tag": "p", "text": "次要段落内容...", "attention": 0.42 },
      { "tag": "li", "text": "侧边栏项目", "attention": 0.25 }
    ],
    "links": [
      { "text": "相关链接", "url": "https://example.com/related" }
    ],
    "images": [
      { "alt": "配图", "src": "https://example.com/img.jpg" }
    ],
    "metadata": {
      "author": "作者",
      "description": "文章摘要"
    }
  }
}
```

### 6. 标签页管理

#### 创建标签页

```
POST /v1/sessions/{sessionId}/tabs
```

请求：
```json
{
  "url": "https://example.com"
}
```

#### 列出标签页

```
GET /v1/sessions/{sessionId}/tabs
```

### 7. 截图

```
GET /v1/sessions/{sessionId}/screenshot
```

返回 base64 编码的页面截图。

### 8. Agent 接口

#### 启动 Agent 任务

```
POST /v1/agent/run
```

请求：
```json
{
  "task": "搜索 AI Browser 相关信息",
  "apiKey": "sk-xxx",
  "baseURL": "https://api.openai.com/v1",
  "model": "gpt-4",
  "headless": true,
  "maxIterations": 20
}
```

#### Agent 事件流

```
GET /v1/agent/{agentId}/events
```

通过 SSE 实时推送 Agent 执行过程中的事件（工具调用、结果、完成等）。

### 9. MCP SSE 端点

供远程 MCP 客户端通过 SSE 传输接入：

#### 建立 SSE 连接

```
GET /mcp/sse
```

返回 SSE 事件流，首条消息包含 `sessionId` 和消息端点 URL。

#### 发送 MCP 消息

```
POST /mcp/message?sessionId=xxx
```

每个 SSE 连接对应一个独立的 MCP Server 实例。
