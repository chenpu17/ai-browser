# 运行观测与排障手册 v0.1（无 LLM 模板运行时）

> 状态：Draft
> 目标：统一 run 级观测口径，保证任务可追踪、可定位、可复盘。

## 1. 观测范围

- 模板运行时（run）
- 步骤执行（step）
- 产物输出（artifact）
- 会话资源（session/tab）

## 2. 关键指标（Metrics）

### 2.1 运行级指标

- `runs_total{templateId,status}`：运行总量与状态分布
- `run_duration_ms{templateId}`：运行耗时
- `run_ttfr_ms{templateId}`：首次结果时间
- `run_retry_total{templateId,step}`：重试次数

### 2.2 稳定性指标

- `run_success_rate{templateId}`：成功率（成功 + partial_success）
- `run_failure_rate{templateId,errorCode}`：失败率与主错误码
- `run_partial_success_rate{templateId}`：部分成功占比

### 2.3 资源指标

- `active_runs`
- `active_sessions`
- `active_tabs`
- `artifact_bytes_total{type}`

## 3. 日志字段规范（Structured Logs）

每条日志至少包含：
- `timestamp`
- `level`
- `runId`
- `templateId`
- `stepId`（可空）
- `event`（`run_started` / `step_failed` / ...）
- `status`
- `elapsedMs`
- `errorCode`（失败时）
- `details`（对象）

### 3.1 敏感信息脱敏

- `credentials`、token、cookie 值必须脱敏。
- 日志中禁止输出明文密码与授权头。

## 4. 事件时间线（Timeline）

建议统一事件：
- `run_created`
- `run_started`
- `step_started`
- `step_retried`
- `step_succeeded`
- `step_failed`
- `artifact_created`
- `run_completed`
- `run_canceled`

## 5. 排障流程

### 场景 A：run 长时间停留在 running

1. 查询 `get_task_run`，确认当前步骤。
2. 检查该步骤最近重试次数和最后错误码。
3. 若为等待类步骤，核对 selector/页面稳定性。
4. 超过阈值后执行 `cancel_task_run` 并导出日志。

### 场景 B：run 失败率突然升高

1. 按模板聚合 `errorCode` TopN。
2. 对比最近版本变更（模板版本/运行时版本）。
3. 抽样回放失败 run 的时间线和截图。
4. 必要时降级并发（模板 `concurrency`）。

### 场景 C：artifact 无法获取

1. 校验 artifact 是否过期（24h 保留期）。
2. 检查大小是否超过 inline 阈值。
3. 验证 `artifactId` 是否属于该 run。

## 6. 值班阈值建议（SLO）

- 15 分钟窗口 `run_failure_rate > 20%`：告警
- 15 分钟窗口 `run_timeout_rate > 10%`：告警
- `active_runs` 接近 `maxConcurrentRuns` 80%：容量告警

## 7. 文档与测试联动

- 每个模板新增或改动都需更新本手册的指标映射。
- 集成测试需覆盖：成功、失败、partial_success、超时、取消、artifact 过期。
