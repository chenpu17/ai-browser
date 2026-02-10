# MCP 契约草案 v0.1（面向无 LLM 任务能力）

> 状态：Draft / RFC
> 范围：在现有工具型 MCP 基础上增加“模板化任务执行”契约，不替代现有工具。

## 1. 设计原则

- 保持兼容：现有 28 个工具不破坏。
- 能力分层：`tool-level` 与 `template-level` 并存。
- 结果可机读：所有新增接口返回稳定 schema。
- 可观测：每个 run 均有唯一 `runId` 与生命周期状态。
- 与 MCP 原生能力不冲突：避免与 initialize 阶段 capability negotiation 同名语义。

## 1.1 当前实现范围（0.2.1+）

**当前已实现工具（7 个）：**

| 工具 | 说明 |
|------|------|
| `list_task_templates` | 列出可用模板目录 |
| `run_task_template` | 创建并运行模板任务（支持 sync + async） |
| `get_task_run` | 查询运行状态与结果 |
| `list_task_runs` | 列表查询历史运行 |
| `cancel_task_run` | 取消运行中的任务 |
| `get_artifact` | 获取产物分片 |
| `get_runtime_profile` | 运行时限额与版本信息 |

> 文档后续章节中标注为“v0.2”的条目，表示设计来源于原 v0.2 规划，但当前代码已提前落地。

## 2. 运行时信息发现

新增工具：`get_runtime_profile`

> 说明：返回运行时限额与版本信息。能力发现（是否支持模板运行）通过 `list_task_templates` 判断——返回非空列表即表示支持。

### 请求

```json
{}
```

### 响应

```json
{
  "runtimeVersion": "0.2.0",
  "limits": {
    "maxConcurrentRuns": 5,
    "maxRunTimeoutMs": 900000,
    "maxArtifactInlineBytes": 262144
  }
}
```

## 3. 模板目录契约

新增工具：`list_task_templates`

### 请求

```json
{}
```

### 响应

```json
{
  "templates": [
    {
      "templateId": "batch_extract_pages",
      "version": "1.0.0",
      "name": "批量页面结构化采集",
      "trustLevelSupport": ["local", "remote"],
      "limits": {
        "maxUrls": 1000,
        "maxConcurrency": 5
      },
      "inputsSchema": { "type": "object" },
      "outputsSchema": { "type": "object" }
    }
  ]
}
```

## 4. 任务运行契约

### 4.1 创建运行

新增工具：`run_task_template`

> 支持 `sync` 与 `async` 两种运行模式。

请求：

```json
{
  "templateId": "batch_extract_pages",
  "templateVersion": "1.0.0",
  "sessionId": "sess_xxx",
  "inputs": {
    "urls": ["https://example.com/a"]
  },
  "options": {
    "timeoutMs": 120000,
    "mode": "auto"
  }
}
```

- `sessionId`（可选）：在指定会话上执行模板。不传时自动创建独立会话。
  - 默认在 run 结束后自动清理；
  - `login_keep_session` 为了“保持会话”能力，自动创建的 session 也会保留。
- `options.mode`（可选，默认 `"auto"`）：执行模式。
  - `"sync"`：阻塞等待，直接返回完整 result。
  - `"async"`：立即返回 `runId`，通过 `get_task_run` 轮询。
  - `"auto"`：由模板规则决定（如 `batch_extract_pages` 按 URL 数量切换）。

响应（async 模式）：

```json
{
  "runId": "run_123",
  "status": "queued",
  "createdAt": 1739145600000
}
```

响应（sync 模式 — 阻塞返回完整结果）：

```json
{
  "runId": "run_123",
  "templateId": "batch_extract_pages",
  "status": "succeeded",
  "progress": {
    "totalSteps": 2,
    "doneSteps": 2
  },
  "metrics": {
    "elapsedMs": 3200
  },
  "result": {
    "summary": { "total": 2, "succeeded": 2, "failed": 0 },
    "items": [
      {
        "url": "https://example.com/a",
        "title": "Page A",
        "success": true
      }
    ]
  }
}
```

> sync 响应格式与 `get_task_run` 终态格式一致，便于客户端统一处理。

### 4.2 查询运行（统一接口）

新增工具：`get_task_run`

> 轮询建议：客户端以 **2 秒**间隔轮询非终态 run。后续版本可能引入 MCP notification 推送终态事件，届时可替代轮询。

请求：

```json
{ "runId": "run_123" }
```

响应（运行中）：

```json
{
  "runId": "run_123",
  "templateId": "batch_extract_pages",
  "status": "running",
  "progress": {
    "totalSteps": 20,
    "doneSteps": 8
  },
  "metrics": {
    "elapsedMs": 5230
  }
}
```

响应（终态）：

```json
{
  "runId": "run_123",
  "templateId": "batch_extract_pages",
  "status": "partial_success",
  "progress": {
    "totalSteps": 20,
    "doneSteps": 20
  },
  "metrics": {
    "elapsedMs": 18022
  },
  "result": {
    "summary": { "total": 10, "succeeded": 9, "failed": 1 },
    "items": []
  },
  "artifacts": [
    { "artifactId": "art_1", "type": "json", "size": 12043 }
  ]
}
```

### 4.3 列表查询

新增工具：`list_task_runs`

请求：

```json
{
  "status": "running",
  "templateId": "batch_extract_pages",
  "limit": 20,
  "offset": 0
}
```

响应：

```json
{
  "runs": [
    {
      "runId": "run_123",
      "templateId": "batch_extract_pages",
      "status": "running",
      "createdAt": 1739145600000,
      "updatedAt": 1739145605230
    }
  ]
}
```

### 4.4 取消运行

新增工具：`cancel_task_run`

> 取消语义：协作式取消。`cancel` 设置标志位，StepExecutor 在**步骤间**检查该标志并停止后续步骤。当前正在执行的步骤会运行完毕，不会被强制中断。已产出的部分结果仍可通过 `get_task_run` 查询。

请求：

```json
{ "runId": "run_123" }
```

响应：

```json
{
  "cancelRequested": true,
  "currentStatus": "running"
}
```

> `cancelRequested: true` 表示取消请求已被接受。`currentStatus` 返回 run 的实际当前状态（可能仍为 `running`，因为当前步骤尚未完成）。客户端通过轮询 `get_task_run` 确认最终状态变为 `canceled`。

## 5. Artifact 契约

新增工具：`get_artifact`

> **v0.2 实现。** v0.1 不包含此工具。
>
> **v0.1 说明**：v0.1 结果直接内联在 `get_task_run` 的 `result` 字段中，不走独立 ArtifactStore。

### 请求

```json
{
  "artifactId": "art_1",
  "offset": 0,
  "limit": 262144
}
```

- `offset`（可选，默认 0）：读取起始字节偏移。
- `limit`（可选，默认 `maxArtifactInlineBytes`）：本次返回的最大字节数。

### 响应（小文件，一次返回）

```json
{
  "artifactId": "art_1",
  "mimeType": "application/json",
  "size": 1024,
  "data": "...base64...",
  "complete": true
}
```

### 响应（大文件，分块返回）

首次请求 `{ "artifactId": "art_2" }`：

```json
{
  "artifactId": "art_2",
  "mimeType": "text/csv",
  "size": 5242880,
  "data": "...base64...(前 256KB)...",
  "offset": 0,
  "bytesReturned": 262144,
  "complete": false
}
```

客户端检查 `complete: false`，继续请求 `{ "artifactId": "art_2", "offset": 262144 }` 直到 `complete: true`。

### 生命周期约束

- artifact TTL 从 **run 进入终态** 开始计算，默认保留 24 小时。
- 单次返回数据量不超过 `maxArtifactInlineBytes`（默认 256KB）。
- artifact 读取失败返回 `ARTIFACT_NOT_FOUND` 或 `ARTIFACT_EXPIRED`。

## 6. 任务状态机（标准）

允许状态：
- `queued`
- `running`
- `succeeded`
- `failed`
- `canceled`
- `partial_success`

状态转移规则：
- `queued -> running -> (succeeded | failed | partial_success | canceled)`
- 终态不可逆。

### `partial_success` 触发条件

- 模板允许部分失败，且成功项比例 >= 模板阈值（默认 50%）。
- 若成功项比例 < 阈值，则状态为 `failed`。
- 阈值优先级：模板定义 > 全局默认。

### 步骤状态到 run 状态的映射

步骤允许状态：`pending` / `running` / `succeeded` / `failed` / `skipped`

映射规则：
- run 被取消时：当前 `running` 步骤运行完毕，所有 `pending` 步骤置为 `skipped`，run 状态变为 `canceled`。
- 所有步骤 `succeeded`：run 状态为 `succeeded`。
- 存在 `failed` 步骤且模板支持 `partial_success`：按成功比例与阈值判定 `partial_success` 或 `failed`。
- 存在 `failed` 步骤且模板不支持 `partial_success`：run 状态为 `failed`。

### 模板 `partial_success` 适用性

并非所有模板都支持 `partial_success`：
- `batch_extract_pages`：支持（多 URL 可部分成功）。
- `multi_tab_compare`：支持（部分 tab 可失败）。
- `login_keep_session`：**不支持**（登录是原子操作，只有 `succeeded` 或 `failed`）。

模板元数据中通过 `supportsPartialSuccess: boolean` 声明。

## 7. 错误码（模板运行扩展）

### 7.1 错误码分层

错误码分为两层，共享统一的响应格式：

- **工具层**（现有）：`ELEMENT_NOT_FOUND`、`NAVIGATION_TIMEOUT`、`SESSION_NOT_FOUND`、`PAGE_CRASHED`、`INVALID_PARAMETER`、`EXECUTION_ERROR`
- **运行时层**（新增）：见下表

| errorCode | 含义 | 恢复建议 |
|---|---|---|
| `TEMPLATE_NOT_FOUND` | 模板不存在 | 调用 `list_task_templates` 获取可用模板 |
| `TEMPLATE_VERSION_UNSUPPORTED` | 模板版本不兼容 | 切换到支持版本 |
| `TRUST_LEVEL_NOT_ALLOWED` | 当前 trustLevel 不允许执行该模板 | 切换连接模式或模板 |
| `RUN_NOT_FOUND` | 运行不存在 | 校验 runId |
| `RUN_TIMEOUT` | 运行超时 | 提高超时阈值或拆分任务 |
| `RUN_CANCELED` | 运行已取消 | 重新创建 run |
| `STEP_EXECUTION_FAILED` | 某步骤执行失败 | 查看 `failedStep` 与 `details` |
| `ARTIFACT_NOT_FOUND` | 产物不存在 | 校验 artifactId |
| `ARTIFACT_EXPIRED` | 产物已过保留期 | 重新执行任务 |

### 7.2 错误响应统一格式

```json
{
  "error": "step failed",
  "errorCode": "STEP_EXECUTION_FAILED",
  "recoverHint": "retry with smaller batch size",
  "details": {
    "runId": "run_123",
    "failedStep": "navigate",
    "stepErrorCode": "NAVIGATION_TIMEOUT"
  }
}
```

### 7.3 错误码映射规则

当 StepExecutor 执行底层工具失败时：
- 运行时层返回 `STEP_EXECUTION_FAILED`。
- `details.stepErrorCode` 携带底层工具层错误码（如 `NAVIGATION_TIMEOUT`、`ELEMENT_NOT_FOUND`）。
- 客户端可根据 `stepErrorCode` 判断具体失败原因，根据 `errorCode` 判断失败层级。

## 8. 运行时架构（实现层）

> 本节定义模板运行时的内部模块结构，指导实现而非约束 MCP 接口。

### 8.1 v0.1 简化架构

v0.1 采用最小化实现，不引入完整 RunManager/StepExecutor/ArtifactStore：

| 模块 | v0.1 实现 | v0.2 升级 |
|------|-----------|-----------|
| run 状态管理 | 简单 `Map<string, RunState>` + 状态机 | 完整 RunManager（并发控制、超时管理、取消） |
| 步骤执行 | `executeBatchExtract(ctx, inputs)` 函数 | 通用 StepExecutor |
| 产物存储 | 结果内联在 `get_task_run` 的 `result` 字段 | 独立 ArtifactStore |

### 8.2 v0.2 完整模块划分

| 模块 | 职责 | 关键接口 |
|------|------|----------|
| `RunManager` | run 生命周期管理（创建、状态机、超时、取消） | `create(templateId, inputs)` → `runId`; `get(runId)`; `cancel(runId)` |
| `StepExecutor` | 单步骤执行（调用底层工具、重试、超时） | `execute(step, context)` → `StepResult` |
| `ArtifactStore` | 产物存储与检索（内联/外联判断、TTL 清理） | `save(runId, data, mime)` → `artifactId`; `get(artifactId)` |

### 8.3 调用链路

v0.1 调用链路：

```
MCP 工具层（run_task_template / get_task_run）
  └→ Map<string, RunState>（状态机）
       └→ executeBatchExtract(ctx, inputs)
            └→ toolActions（navigate, wait_for_stable, get_page_info, get_page_content, create_tab, close_tab）
```

v0.2 调用链路：

```
MCP 工具层（run_task_template / get_task_run / ...）
  └→ RunManager（状态机 + 并发控制）
       └→ StepExecutor（按模板 steps 顺序/并发编排）
            └→ 现有 MCP 工具的内部逻辑（navigate, get_page_info, ...）
```

### 8.4 前置重构：工具逻辑提取

当前工具的业务逻辑内联在 `browser-mcp-server.ts` 的 `server.tool()` 回调中。模板执行需要复用这些逻辑但不经过 MCP 协议层。

**v0.1 提取范围**：仅 6 个工具（`batch_extract_pages` 所需）：
- `navigate`
- `wait_for_stable`
- `get_page_info`
- `get_page_content`
- `create_tab`
- `close_tab`

**重构方案**：将每个工具的核心逻辑提取为独立函数，通过 `ToolContext` 注入依赖：

```typescript
interface ToolContext {
  sessionManager: SessionManager;
  cookieStore?: CookieStore;
  urlOpts: ValidateUrlOptions;
  trustLevel: TrustLevel;
  resolveSession(sessionId?: string): Promise<string>;
}
// 示例：toolActions.navigate(ctx, url, opts)
```

- MCP handler 构造的 `ToolContext`：`resolveSession` 走 defaultSession 逻辑。
- 模板执行构造的 `ToolContext`：`resolveSession` 直接返回 run 绑定的 sessionId，不走 default session。
- 模板执行在并发 tab 场景下通过显式 `tabId` 参数操作指定 tab，不依赖 `activeTabId`。

此重构是 Milestone A 的前置依赖。ToolContext 接口保留（v0.2 StepExecutor 复用）。

### 8.5 会话隔离策略

- **默认行为**：未传 `sessionId` 时，RunManager 为每个 run 创建独立 session。除 `login_keep_session` 外，run 进入终态后自动关闭该 session（直接调用 `sessionManager.close()`，绕过 MCP 层的 headful 保留逻辑）。
- **复用会话**：传入 `sessionId` 时，run 在指定 session 上执行，run 结束后**不**关闭该 session（由调用方管理生命周期）。
- **资源上限**：`maxConcurrentRuns`（默认 5）× 单 run 最大 tab 数 不得超出浏览器进程承载能力。建议总 tab 数上限 = 50。

### 8.6 并发约束映射

- `RunManager` 维护全局 `maxConcurrentRuns` 计数器。
- `StepExecutor` 在批量模板中维护滑动窗口，窗口大小 = `min(模板 concurrency, maxConcurrency, MAX_TABS_PER_SESSION - 已占用 tab 数)`。
- 每个 tab 使用完毕后必须调用 `close_tab` 释放槽位，避免触及 `MAX_TABS_PER_SESSION`（当前 20）上限。

## 9. trustLevel 继承规则

- `run_task_template` 默认继承当前 MCP 连接 trustLevel。
- 模板声明 `trustLevelSupport`，不满足时返回 `TRUST_LEVEL_NOT_ALLOWED`。
- 模板内子步骤（navigate/upload/execute_javascript）不得绕过该继承规则。

## 10. 并发与限额模型

- `maxConcurrentRuns`：运行时级别的并发 run 上限。
- 模板参数 `concurrency`：单 run 内并行工作单元（如 tab）数量。
- 两者是不同维度，均需满足。

### 超时优先级

实际生效超时 = `min(用户传入 options.timeoutMs, 模板 maxTimeoutMs, 运行时 maxRunTimeoutMs)`。

若用户未传 `timeoutMs`，则使用模板 `maxTimeoutMs` 作为默认值。

## 11. 兼容性约束

- 旧客户端只调用现有工具时，不受影响。
- 新客户端应先调用 `list_task_templates` 判断是否支持模板能力。v0.2 可通过 `get_runtime_profile` 获取限额信息。
- 模板结果字段新增必须向后兼容（仅新增可选字段）。

## 12. 验收条件（契约层）

- 契约示例可被 JSON Schema 校验通过。
- `batch_extract_pages` 模板能跑通 `run_task_template -> get_task_run` 全链路（sync + async 双模式）。
- v0.1 结果内联在 `get_task_run` 的 `result` 字段中可正确读取。
- v0.2：至少 3 个模板能跑通 `run -> get_task_run -> artifact` 全链路。

## 13. v0.1 vs v0.2 能力对照表

| 能力 | v0.1 | v0.2 |
|------|------|------|
| `list_task_templates` | ✅ | ✅ |
| `run_task_template`（sync + async） | ✅ | ✅ |
| `get_task_run` | ✅ | ✅ |
| `get_runtime_profile` | ❌ | ✅ |
| `list_task_runs` | ❌ | ✅ |
| `cancel_task_run` | ❌ | ✅ |
| `get_artifact` | ❌ | ✅ |
| `batch_extract_pages` 模板 | ✅ | ✅ |
| `login_keep_session` 模板 | ❌ | ✅ |
| `multi_tab_compare` 模板 | ❌ | ✅ |
