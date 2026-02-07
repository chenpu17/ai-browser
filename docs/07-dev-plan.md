# 开发计划

## 概述

本文档是 AI Browser 的详细开发计划，关联设计文档中的具体章节。

## 文档关联

| 设计文档 | 内容 |
|----------|------|
| [01-architecture.md](./01-architecture.md) | 整体架构、分层设计 |
| [02-semantic-engine.md](./02-semantic-engine.md) | 语义引擎各模块设计 |
| [03-api-design.md](./03-api-design.md) | API 接口定义 |
| [04-data-structures.md](./04-data-structures.md) | 数据结构定义 |
| [06-testing.md](./06-testing.md) | 测试策略 |

---

## Phase 1: 基础框架

### 1.1 项目初始化

| 任务 | 说明 | 关联文档 |
|------|------|----------|
| 1.1.1 创建项目结构 | TypeScript + Node.js 脚手架 | 05-roadmap.md#技术栈 |
| 1.1.2 配置构建工具 | tsconfig, eslint, prettier | - |
| 1.1.3 配置测试框架 | Vitest 单元测试 | 06-testing.md#单元测试 |

**验收标准**: `npm run build` 和 `npm test` 正常运行

### 1.2 浏览器控制层

| 任务 | 说明 | 关联文档 |
|------|------|----------|
| 1.2.1 Puppeteer 封装 | 浏览器启动、关闭 | 01-architecture.md#浏览器控制层 |
| 1.2.2 会话管理 | 创建、获取、删除会话 | 03-api-design.md#会话管理 |
| 1.2.3 页面导航 | 打开URL、等待加载 | 03-api-design.md#页面导航 |

**验收标准**: 能创建会话、打开页面、关闭会话

### 1.3 API 服务层

| 任务 | 说明 | 关联文档 |
|------|------|----------|
| 1.3.1 Fastify 服务 | HTTP 服务启动 | 01-architecture.md#API层 |
| 1.3.2 会话接口 | POST/GET/DELETE /v1/sessions | 03-api-design.md#会话管理 |
| 1.3.3 导航接口 | POST /v1/sessions/{id}/navigate | 03-api-design.md#页面导航 |
| 1.3.4 错误处理 | 统一错误响应格式 | 03-api-design.md#错误响应 |

**验收标准**: API 接口可调用，返回正确格式

### 1.4 基础语义采集

| 任务 | 说明 | 关联文档 |
|------|------|----------|
| 1.4.1 AXTree 采集 | 获取 Accessibility Tree | 02-semantic-engine.md#输入采集器 |
| 1.4.2 元素列表输出 | 基础元素索引 | 02-semantic-engine.md#元素索引器 |
| 1.4.3 语义接口 | GET /v1/sessions/{id}/semantic | 03-api-design.md#页面读取 |

**验收标准**: 打开页面后能获取元素列表

### Phase 1 验收场景

```
1. 创建会话
2. 打开 https://example.com
3. 获取页面语义（元素列表）
4. 关闭会话
```

---

## Phase 2: 语义引擎

### 2.1 页面理解器

| 任务 | 说明 | 关联文档 |
|------|------|----------|
| 2.1.1 页面类型识别 | 规则引擎实现 | 02-semantic-engine.md#页面理解器 |
| 2.1.2 意图提取 | 识别页面可执行意图 | 04-data-structures.md#意图 |

**验收标准**: 能正确识别登录页、搜索页等类型

### 2.2 元素索引器增强

| 任务 | 说明 | 关联文档 |
|------|------|----------|
| 2.2.1 语义ID生成 | 可读、稳定的ID | 02-semantic-engine.md#语义ID生成规则 |
| 2.2.2 ID冲突处理 | 消歧逻辑 | 02-semantic-engine.md#ID冲突处理 |
| 2.2.3 稳定句柄 | backendNodeId 关联 | 02-semantic-engine.md#稳定句柄机制 |

**验收标准**: 元素ID可读且稳定

### 2.3 状态追踪器

| 任务 | 说明 | 关联文档 |
|------|------|----------|
| 2.3.1 页面状态监听 | 加载、DOM变化 | 02-semantic-engine.md#状态追踪器 |
| 2.3.2 智能就绪判断 | 静默窗口模型 | 02-semantic-engine.md#智能就绪判断 |

**验收标准**: 能准确判断页面就绪状态

### 2.4 操作执行器

| 任务 | 说明 | 关联文档 |
|------|------|----------|
| 2.4.1 基础操作 | click, type, select | 02-semantic-engine.md#操作执行器 |
| 2.4.2 元素定位 | 语义ID → 元素 | 02-semantic-engine.md#元素定位策略 |
| 2.4.3 操作接口 | POST /v1/sessions/{id}/action | 03-api-design.md#页面操作 |

**验收标准**: 能通过语义ID执行点击、输入操作

### Phase 2 验收场景

```
1. 打开登录页
2. 识别为 LOGIN 类型
3. 填写用户名、密码
4. 点击登录按钮
```

---

## Phase 3: 操作增强

### 3.1 高级操作

| 任务 | 说明 | 关联文档 |
|------|------|----------|
| 3.1.1 批量操作 | POST /v1/sessions/{id}/actions | 03-api-design.md#批量操作 |
| 3.1.2 模糊匹配 | 候选列表返回 | 02-semantic-engine.md#元素定位策略 |

**验收标准**: 批量操作可执行，模糊匹配返回候选

### 3.2 错误处理

| 任务 | 说明 | 关联文档 |
|------|------|----------|
| 3.2.1 错误码定义 | 统一错误类型 | 01-architecture.md#错误处理 |
| 3.2.2 错误恢复 | 重试、降级策略 | - |

**验收标准**: 错误信息清晰，可恢复错误自动重试

### 3.3 iframe 处理

| 任务 | 说明 | 关联文档 |
|------|------|----------|
| 3.3.1 iframe 检测 | 识别页面中的iframe | 02-semantic-engine.md#iframe处理器 |
| 3.3.2 跨域限制 | 处理跨域iframe | 02-semantic-engine.md#跨域iframe限制 |

**验收标准**: 能获取同源iframe内的元素

---

## Phase 4: 扩展能力

### 4.1 内容提取

| 任务 | 说明 | 关联文档 |
|------|------|----------|
| 4.1.1 内容接口 | GET /v1/sessions/{id}/content | 03-api-design.md#内容提取 |
| 4.1.2 动态内容 | 懒加载、无限滚动 | 02-semantic-engine.md#动态内容处理器 |

**验收标准**: 能提取文章页的正文内容

### 4.2 模型扩展

| 任务 | 说明 | 关联文档 |
|------|------|----------|
| 4.2.1 适配器接口 | SemanticModelAdapter | 04-data-structures.md#模型扩展接口 |

**验收标准**: 可注册外部模型增强语义理解

---

## 任务依赖关系

```
Phase 1
1.1 项目初始化
    ↓
1.2 浏览器控制层 ──→ 1.3 API服务层
    ↓                    ↓
1.4 基础语义采集 ←───────┘

Phase 2 (依赖 Phase 1)
2.1 页面理解器
2.2 元素索引器增强
2.3 状态追踪器
    ↓
2.4 操作执行器

Phase 3 (依赖 Phase 2)
3.1 高级操作
3.2 错误处理
3.3 iframe处理

Phase 4 (依赖 Phase 3)
4.1 内容提取
4.2 模型扩展
```
