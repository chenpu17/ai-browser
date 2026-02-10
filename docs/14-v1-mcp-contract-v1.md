# MCP 契约 v1（冻结草案，修订版）

> 状态：Draft-Freeze Candidate
> 适用范围：AI Browser Task Runtime（stdio + SSE）
> 关联文档：`docs/13-intelligent-browser-terminal-prd-v1-draft.md`、`docs/15-v1-agent-implementation-plan.md`

## 1. 契约目标与边界

- 冻结 v1 的任务运行接口语义，避免实现歧义。
- 兼容现有 7 个 task runtime 工具。
- v1 只做语义收敛，不做破坏性替换。
- 事件订阅能力（`subscribe_task_run_events`）放到 v1.1。

## 2. 工具矩阵（已有/改造/新增）

| 工具 | v0.2.x 状态 | v1 动作 | 兼容性 |
|---|---|---|---|
| `list_task_templates` | 已有 | 保持 | 向后兼容 |
| `run_task_template` | 已有 | 改造：补可选 `options.idempotencyKey` / `options.outputSchema` 语义 | 向后兼容 |
| `get_task_run` | 已有 | 改造：统一终态/非终态语义，补时间字段说明 | 向后兼容 |
| `list_task_runs` | 已有 | 改造：明确排序与过滤语义 | 向后兼容 |
| `cancel_task_run` | 已有 | 保持 | 向后兼容 |
| `get_artifact` | 已有 | 保持（沿用现有 chunk 结构） | 向后兼容 |
| `get_runtime_profile` | 已有 | 保持，补字段定义说明 | 向后兼容 |
| `subscribe_task_run_events` | 无 | 新增候选（v1.1） | 不在 v1 |

## 3. 核心对象语义

### 3.1 RunStatus（冻结）

```ts
'queued' | 'running' | 'succeeded' | 'failed' | 'partial_success' | 'canceled'
```

### 3.2 Run 对象（对外）

```json
{
  "runId": "run_xxx",
  "templateId": "batch_extract_pages",
  "sessionId": "sess_xxx",
  "ownsSession": true,
  "status": "running",
  "progress": { "doneSteps": 2, "totalSteps": 10 },
  "metrics": { "elapsedMs": 1234 },
  "result": null,
  "error": null,
  "artifactIds": ["art_xxx"],
  "createdAt": 1739188800000,
  "updatedAt": 1739188801234
}
```

语义约束：
- `createdAt` / `updatedAt` 都是 Unix 毫秒时间戳（number）。
- 非终态：`result=null` 且 `error=null`。
- 终态成功：`status in [succeeded, partial_success]`，`result` 可用。
- 终态失败：`status in [failed, canceled]`，`error` 必须可解释。

### 3.3 ArtifactChunk（与当前代码对齐）

`get_artifact` 返回结构：

```json
{
  "artifactId": "art_xxx",
  "mimeType": "application/json",
  "totalSize": 1032448,
  "offset": 0,
  "length": 262144,
  "data": "...",
  "complete": false
}
```

说明：
- `length`：本次 chunk 实际长度。
- `complete=true` 表示已到末尾。
- v1 不返回 `encoding` / `nextOffset` / `truncated` 字段。

## 4. 工具契约（v1）

## 4.1 `run_task_template`

入参：

```json
{
  "templateId": "batch_extract_pages",
  "sessionId": "sess_xxx",
  "inputs": {},
  "options": {
    "mode": "auto",
    "timeoutMs": 300000,
    "idempotencyKey": "task_20260210_001",
    "outputSchema": { "type": "object" }
  }
}
```

字段规则：
- `mode`：保留 `sync/async/auto`。
- `timeoutMs`：1 ~ 600000。
- `idempotencyKey`（可选）：请求去重键。
- `outputSchema`（可选）：v1 仅 TaskAgent 路径生效，直接模板执行路径忽略。

返回：
- `sync`：返回终态 run（含 result）。
- `async`：返回 `runId + queued/running`。
- `auto`：服务决定实际模式，并在返回中给出实际 mode（字段名仍为 `mode`）。

`async` 返回示例：

```json
{
  "runId": "run_xxx",
  "sessionId": "sess_xxx",
  "status": "queued",
  "mode": "async",
  "deduplicated": false
}
```

`idempotencyKey` 命中去重示例：

```json
{
  "runId": "run_existing",
  "sessionId": "sess_xxx",
  "status": "running",
  "mode": "async",
  "deduplicated": true
}
```

### 4.1.1 `idempotencyKey` 行为（冻结）

- 唯一性范围：`(templateId, idempotencyKey)`。
- 作用窗口：与 run TTL 一致（默认 30 分钟）。
- 重复提交行为：
  - 若窗口内存在同键 run，返回已有 `runId`，并返回 `deduplicated=true`。
  - 若窗口内不存在，则创建新 run。
- 作用目标：防止客户端重复提交，不保证业务幂等。

## 4.2 `get_task_run`

入参：

```json
{ "runId": "run_xxx" }
```

返回：统一 Run 对象（见 3.2）。

## 4.3 `list_task_runs`

入参：

```json
{
  "status": "running",
  "templateId": "batch_extract_pages",
  "limit": 50,
  "offset": 0
}
```

约束：
- `status`：RunStatus 枚举。
- `limit`：1~1000。
- `offset`：>=0。

排序与数量语义：
- 默认按 `createdAt` 降序（newest first）。
- `total` = 过滤后的总量（不是分页后数量）。

## 4.4 `cancel_task_run`

行为约束：
- 运行中任务：进入 `canceled`，errorCode=`RUN_CANCELED`。
- 终态任务：返回 `success=false` + reason（不抛错）。
- 不存在 run：返回 `RUN_NOT_FOUND`。

## 4.5 `get_runtime_profile`

最低保障字段：

```json
{
  "maxConcurrentRuns": 5,
  "maxUrls": 1000,
  "maxTabsPerSession": 20,
  "syncTimeoutMs": 300000,
  "asyncTimeoutMs": 600000,
  "artifactMaxChunkSize": 262144,
  "artifactTtlMs": 86400000,
  "runTtlMs": 1800000,
  "supportedModes": ["sync", "async", "auto"],
  "trustLevel": "local",
  "isRemote": false
}
```

## 5. 错误码（全量 16 个）与恢复建议

| errorCode | 恢复建议 |
|---|---|
| `ELEMENT_NOT_FOUND` | 刷新页面语义后重试；必要时改 selector/语义查询 |
| `NAVIGATION_TIMEOUT` | 放宽等待条件、增加超时或拆分步骤 |
| `SESSION_NOT_FOUND` | 重建会话并重试任务 |
| `PAGE_CRASHED` | 重建 tab/session 后从安全步骤恢复 |
| `INVALID_PARAMETER` | 修正参数范围或类型 |
| `EXECUTION_ERROR` | 检查脚本/步骤前置条件，必要时降级执行 |
| `TEMPLATE_NOT_FOUND` | 修正 templateId 或升级客户端模板清单 |
| `RUN_NOT_FOUND` | 校验 runId/TTL，必要时重新提交 |
| `RUN_TIMEOUT` | 增加 timeoutMs、减少批量规模或拆分任务 |
| `RUN_CANCELED` | 用户取消后的预期终态，可按需重新提交 |
| `STEP_EXECUTION_FAILED` | 根据失败 step 做局部重试或补救 |
| `TRUST_LEVEL_NOT_ALLOWED` | 切换 trustLevel 或改用支持模板 |
| `TEMPLATE_VERSION_UNSUPPORTED` | 切换模板版本或升级服务端 |
| `ARTIFACT_NOT_FOUND` | 校验 artifactId / run 关联关系 |
| `ARTIFACT_EXPIRED` | 在 TTL 内读取或重新执行任务生成产物 |
| `TPL_LOGIN_FIELD_NOT_FOUND` | 调整登录字段映射/语义定位规则 |

## 6. 兼容与迁移

- v1 不删除现有字段；仅追加可选字段。
- 旧客户端可继续使用 polling 路径。
- `outputSchema` 为“软增强”字段：旧调用不会受影响。

## 7. 里程碑映射（与 PRD/Agent 计划对齐）

- Milestone A（W1-W2）：冻结本契约字段与语义，补齐契约测试。
- Milestone C（W6-W7）：落地 run/result/artifact 语义收敛与兼容改造。
- Milestone D（W8）：完成回归验证并随版本发布。

## 8. 契约测试清单（扩展版）

- [ ] `run_task_template` 三模式兼容（sync/async/auto）
- [ ] `get_task_run` 终态/非终态字段语义一致
- [ ] `list_task_runs.total` 为过滤后总数，且默认按 createdAt 降序
- [ ] `cancel_task_run` 对终态 run 返回 `success=false` + reason
- [ ] `idempotencyKey` 去重行为（窗口内重复提交返回同 run）
- [ ] `get_artifact` chunk 字段与边界行为（`length/complete`）
- [ ] `get_runtime_profile` 字段完整性
- [ ] 并发超限时提交任务返回 `status=queued`，且排队后可正常执行完成
- [ ] 16 个错误码至少有 1 个契约用例覆盖
