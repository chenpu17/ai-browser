# 任务模板清单 v0.1（无 LLM）

> 状态：Draft
> 目标：定义首批可稳定交付的任务模板，并明确输入、流程、输出、失败恢复与验收标准。

## 1. 模板统一规范

每个模板必须定义：
- `templateId`：全局唯一标识。
- `version`：语义化版本。
- `trustLevelSupport`：可运行的信任级别（`local` / `remote`，与代码 `TrustLevel` 类型一致）。
- `supportsPartialSuccess`：是否支持 `partial_success` 终态（批量类模板为 `true`，原子操作模板为 `false`）。
- `executionMode`：执行模式，取值 `"sync"` | `"async"` | `"auto"`。
  - `sync`：`run_task_template` 阻塞返回完整 result。
  - `async`：返回 `runId`，通过 `get_task_run` 轮询。
  - `auto`：由运行时根据任务规模自动选择（模板可定义切换规则）。
  - 调用方可通过 `options.mode` 强制指定 `sync` 或 `async`，覆盖模板默认值。
- `inputs`：参数 schema（类型、必填、默认值、约束）。
- `limits`：模板级限制（最大 URL、最大并发、最大超时等）。
- `steps`：确定性执行步骤（含重试/超时策略）。
- `outputs`：结构化输出 schema。
- `errors`：模板专属错误码。
- `acceptance`：可量化验收标准。

## 2. 首批模板目录

| templateId | 名称 | 目标场景 | 版本 |
|---|---|---|---|
| `batch_extract_pages` | 批量页面结构化采集 | 多 URL 批量抓取页面信息 | 1.0.0 |
| `login_keep_session` | 登录并保持会话 | 人工/半自动登录后继续自动化任务 | 1.0.0 |
| `multi_tab_compare` | 多标签对比采集 | 同时打开多个页面并汇总差异 | 1.0.0 |

> 当前实现（0.2.1+）已同时提供上述三个模板。

---

## 3. 模板 A：`login_keep_session`

### 元数据

- `version`: `1.0.0`
- `trustLevelSupport`: `local`
- `supportsPartialSuccess`: `false`
- `limits`:
  - `maxTimeoutMs`: `60000`

### 用户价值

在登录流程稳定后复用会话，避免每次任务重复登录。

### 输入参数

支持两种定位模式：
- `selector` 模式：直接使用 CSS 选择器（精确、稳定）。
- `semantic` 模式：通过语义查找（`find_element`）定位账号/密码/提交元素（更通用）。

```json
{
  "startUrl": "https://example.com/login",
  "locateMode": "selector",
  "selectors": {
    "username": "#username",
    "password": "#password",
    "submit": "button[type=submit]",
    "success": ".dashboard"
  },
  "semanticHints": {
    "username": "username input",
    "password": "password input",
    "submit": "login button",
    "success": "dashboard"
  },
  "credentials": {
    "username": "alice",
    "password": "***"
  },
  "waitTimeoutMs": 15000
}
```

### 执行步骤（确定性）

1. `validateUrl(startUrl)`。
2. `navigate(startUrl)`。
3. 按 `locateMode` 执行：
   - `selector`：`wait(selector=username/password)`。
   - `semantic`：`get_page_info`（触发语义 ID 注入）→ `find_element` 定位字段。注意：每次页面导航后需重新调用 `get_page_info` 以重新注入语义 ID。
4. 输入账号密码并提交。
5. `wait(selector=success)` 或 `wait_for_stable`。
6. 输出 `sessionId + currentUrl + loginState`。

### 输出

```json
{
  "success": true,
  "sessionId": "sess_xxx",
  "page": { "url": "https://example.com/dashboard", "title": "Dashboard" },
  "loginState": "authenticated"
}
```

### 敏感信息处理

- `credentials` 仅用于本次 run 的内存态执行，不持久化。
- 运行日志与产物中必须脱敏（例如密码字段输出 `***`）。
- 该模板默认不在 `remote` 模式下暴露。

### 失败恢复

- 输入框不存在：`TPL_LOGIN_FIELD_NOT_FOUND`。
- 提交后超时：仅重试步骤 4-5（一次）。
- 成功标记未出现：输出 `loginState=unknown` 并附截图。

### 验收标准

- 固定测试站点登录首轮成功率 >= 90%（高于 PRD 整体 85% 下限，为其他模板留余量）。
- 失败时 100% 给出失败步骤与错误码。

---

## 4. 模板 B：`batch_extract_pages`

### 元数据

- `version`: `1.0.0`
- `trustLevelSupport`: `local`, `remote`
- `supportsPartialSuccess`: `true`
- `partialSuccessThreshold`: `0.5`
- `executionMode`: `auto`
- `limits`:
  - `maxUrls`: `1000`
  - `maxConcurrency`: `5`
  - `maxTimeoutMs`: `900000`

### 执行模式

- 默认 `executionMode: "auto"`，规则如下：
  - URL 数 <= 10 → **sync**：`run_task_template` 阻塞返回完整 result。
  - URL 数 > 10 → **async**：返回 `runId`，通过 `get_task_run` 轮询。
- 调用方可通过 `options.mode` 强制指定 `"sync"` 或 `"async"`，覆盖 auto 规则。

### 用户价值

将 URL 列表一次性转成结构化数据，直接用于分析或入库。

### 输入参数

```json
{
  "urls": [
    "https://example.com/a",
    "https://example.com/b"
  ],
  "extract": {
    "pageInfo": true,
    "content": true,
    "maxElements": 50,
    "maxContentLength": 4000
  },
  "concurrency": 3
}
```

### 并发模型说明

- `concurrency` 表示**同一 run 内并行 tab 数**，不是并行 session 数。
- 执行采用滑动窗口：任一时刻最多 `concurrency` 个活动 tab。
- `concurrency` 受模板 `maxConcurrency` 和系统能力上限共同约束。

### URL 校验与 trust 继承

- 每个 URL 在执行前必须走统一 URL 校验。
- 模板执行继承当前连接 trustLevel；受限模式下应阻断不允许的 URL（如私网地址）。

### 执行步骤

1. 预校验 URL 列表（格式、数量、协议、策略）。
2. 按滑动窗口并发执行每个 URL：
   - `create_tab` → `navigate`
   - `wait_for_stable`
   - `get_page_info`
   - `get_page_content`
   - `close_tab`（释放 tab 槽位，供后续 URL 复用）
3. 聚合结果并生成 `summary`。
4. 导出 `json` 与可选 `csv`。

### 输出

```json
{
  "success": true,
  "summary": {
    "total": 2,
    "succeeded": 2,
    "failed": 0
  },
  "items": [
    {
      "url": "https://example.com/a",
      "title": "Page A",
      "pageType": "article",
      "elementCount": 23,
      "contentSections": 8,
      "success": true
    }
  ],
  "artifacts": [
    { "type": "json", "artifactId": "art_xxx" }
  ]
}
```

### 失败恢复

- 单 URL 失败不阻断整批，记录 `item.success=false`。
- 超时 URL 最多重试 1 次。
- 成功比例 >= `partialSuccessThreshold`（默认 50%）时，run 置为 `partial_success`；低于阈值则置为 `failed`。

### 验收标准

- 100 个 URL 批次任务完整执行率 >= 95%。
- 单 URL 失败不会导致 run 崩溃。

---

## 5. 模板 C：`multi_tab_compare`

### 元数据

- `version`: `1.0.0`
- `trustLevelSupport`: `local`, `remote`
- `supportsPartialSuccess`: `true`
- `limits`:
  - `maxUrls`: `10`
  - `maxTimeoutMs`: `180000`

### 用户价值

快速对比多个页面在标题、核心元素数量、关键文案上的差异。

### 输入参数

```json
{
  "urls": [
    "https://example.com/pricing",
    "https://example.com/pricing?locale=en"
  ],
  "compare": {
    "fields": ["title", "elementCount", "topSections"],
    "topSections": 3,
    "numericTolerance": 0
  }
}
```

### Diff 语义定义

- `title`：规范化后精确匹配（trim + 小写）。
- `elementCount`：按 `numericTolerance` 判断差异。
- `topSections`：按位置对齐比较前 N 段文本，支持轻量归一化（去空白、大小写归一）。

### 执行步骤

1. 为每个 URL 创建 tab 并导航。
2. 每个 tab 运行：`wait_for_stable -> get_page_info -> get_page_content`。
3. 按 compare 字段执行 diff。
4. 输出 diff 结构化结果。

### 输出

```json
{
  "success": true,
  "tabs": [
    { "tabId": "tab_1", "url": "...", "title": "Pricing" },
    { "tabId": "tab_2", "url": "...", "title": "Pricing - EN" }
  ],
  "diff": {
    "title": { "same": false, "left": "Pricing", "right": "Pricing - EN" },
    "elementCount": { "same": false, "left": 42, "right": 39, "delta": 3 },
    "topSections": { "same": false, "changedPositions": [1, 3] }
  }
}
```

### 失败恢复

- 某 tab 失败则标记 `tab.partial=true`，其余 tab 继续。
- 最终 diff 支持 partial 数据并附 `warnings`。

### 验收标准

- 2~5 页对比任务平均完成时间 <= 20 秒（本地环境）。
- diff 字段准确率（基准用例）>= 95%。

## 6. 模板版本策略

- 向后兼容改动：`minor` 升级（如新增可选参数）。
- 不兼容改动：`major` 升级（字段删除、语义变化）。
- 模板响应中始终返回 `templateId + templateVersion` 便于客户端适配。
