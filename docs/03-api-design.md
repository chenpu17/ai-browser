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
    "type": "article",
    "title": "文章标题",
    "body": "文章正文内容...",
    "metadata": {
      "author": "作者",
      "date": "2026-02-05"
    }
  }
}
```
