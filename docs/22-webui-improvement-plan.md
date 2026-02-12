# Web UI 体验优化开发计划

## 背景

经过 UX 审查和 subagent 评审，确认 8 项有效改进。本计划按优先级分 3 批交付，每批独立可验证。

## 当前技术栈

- 纯 HTML + Vanilla JS（无框架）
- CSS 变量设计系统（GitHub 暗色主题）
- 单文件 SPA：`public/index.html`（Semantic + Agent 两个视图）
- 独立页面：`public/tasks.html`、`public/task-result.html`
- 后端 SSE 事件流：`/v1/agent/:id/events`

## 优先级排序

| 批次 | 改进项 | 优先级 | 影响面 |
|------|--------|--------|--------|
| P1 | Agent 进度条 | 高 | 核心体验 |
| P1 | 工具调用消息人性化 | 高 | 信息可读性 |
| P1 | Task 页面集成到 SPA | 高 | 导航一致性 |
| P2 | Settings 连接测试 | 中 | 配置体验 |
| P2 | 聊天历史持久化 | 中 | 会话连续性 |
| P2 | 截图刷新动画 | 中 | 视觉反馈 |
| P3 | 移动端响应式 | 低 | 移动适配 |
| P3 | Token 用量展示 | 低 | 可观测性 |

---

## P1 批次：核心体验提升

### 1.1 Agent 进度条

**问题**: Agent 运行时用户只能看到消息流，无法直观感知整体进度。后端已有 `progress` 事件（含 `phase`、`percent`、`stepsRemaining`），但前端未消费。

**修改文件**: `public/index.html`

**实现要点**:

1. CSS 新增 `.progress-bar-wrap` + `.progress-bar-fill`（3px 高度，accent 色，0.4s 过渡动画）
2. CSS 新增 `.progress-info`（phase 文字 + 百分比 + 剩余步数）
3. HTML：在 `#chatPanel` 输入区域上方插入进度条和信息行
4. JS `Agent.handleEvent` 增加 `case 'progress'`：
   - 设置 `progressFill.style.width = percent + '%'`
   - 显示 phase（capitalize）、百分比、剩余步数
   - 添加 `.active` class 显示进度条
5. JS `Agent.resetUI` 和 `Agent.clearChat` 中隐藏并重置进度条

**验证**: 启动 Agent 任务，观察进度条从 0% 平滑增长到 100%，phase 文字随工具调用变化。

### 1.2 工具调用消息人性化

**问题**: `tool_call` 消息直接展示工具名 + 原始 JSON 参数，对非技术用户不友好。

**修改文件**: `public/index.html`

**实现要点**:

1. 新增 `Agent.humanizeToolCall(name, args)` 函数，返回人类可读描述：

```javascript
Agent.humanizeToolCall = function(name, args) {
  var map = {
    navigate: function(a) { return '打开页面: ' + (a.url || ''); },
    click: function(a) { return '点击: ' + (a.elementId || a.element_id || ''); },
    type_text: function(a) { return '输入文字: "' + (a.text || '').slice(0, 30) + '"'; },
    get_page_info: function() { return '获取页面元素信息'; },
    get_page_content: function() { return '提取页面内容'; },
    find_element: function(a) { return '搜索元素: "' + (a.query || '') + '"'; },
    screenshot: function() { return '截取页面截图'; },
    scroll: function(a) { return '滚动页面 ' + (a.direction || 'down'); },
    press_key: function(a) { return '按键: ' + (a.key || ''); },
    select_option: function(a) { return '选择选项: ' + (a.value || ''); },
    fill_form: function(a) { return '填写表单 (' + (a.fields?.length || 0) + ' 个字段)'; },
    click_and_wait: function(a) { return '点击并等待: ' + (a.element_id || ''); },
    navigate_and_extract: function(a) { return '导航并提取: ' + (a.url || ''); },
    hover: function(a) { return '悬停: ' + (a.elementId || a.element_id || ''); },
    go_back: function() { return '返回上一页'; },
    wait: function(a) { return '等待: ' + (a.condition || a.ms + 'ms'); },
    wait_for_stable: function() { return '等待页面稳定'; },
    done: function(a) { return '任务完成: ' + (a.result || '').slice(0, 50); },
  };
  var fn = map[name];
  return fn ? fn(args) : name + '(' + Object.keys(args).join(', ') + ')';
};
```

2. 修改 `Agent.addMsg` 中 `case 'tool_call'`：
   - 主文本用 `humanizeToolCall` 生成的描述
   - 原始 JSON 折叠在 `<details>` 中，默认收起

```javascript
case 'tool_call':
  el.className = 'msg msg-tool-call';
  var desc = self.humanizeToolCall(content, extra);
  el.innerHTML = self.stepTag(iteration) +
    '<div class="tool-header"><span class="tool-icon">▶</span> ' + esc(desc) + '</div>' +
    '<details class="tool-raw"><summary>原始参数</summary><pre>' +
    esc(JSON.stringify(extra, null, 2)) + '</pre></details>';
  break;
```

3. CSS 新增 `.tool-raw` 样式（折叠区域，灰色边框，小字号）

**验证**: Agent 运行时，tool_call 消息显示如"打开页面: https://..."，点击"原始参数"可展开查看 JSON。

### 1.3 Task 页面集成到 SPA 导航

**问题**: `tasks.html` 和 `task-result.html` 是独立页面，与主 SPA 无导航关联，用户需要手动输入 URL 访问。

**修改文件**: `public/index.html`

**实现要点**:

1. 导航栏增加第三个 tab "Tasks"：
```html
<button class="nav-tab" onclick="switchView('tasks')" id="tabTasks">Tasks</button>
```

2. 新增 `#tasksView` 容器（与 `#semanticView`、`#agentView` 同级）：
```html
<div id="tasksView" class="view-panel" style="display:none">
  <div class="tasks-toolbar">
    <button class="btn btn-save" onclick="Tasks.showCreateForm()">+ New Task</button>
    <button class="btn" onclick="Tasks.refreshList()">Refresh</button>
  </div>
  <div id="tasksList" class="tasks-list"></div>
  <div id="taskDetail" class="task-detail" style="display:none"></div>
</div>
```

3. 新增 `Tasks` 对象，包含：
   - `Tasks.refreshList()` — 调用 `GET /v1/tasks` 获取任务列表，渲染为卡片
   - `Tasks.showCreateForm()` — 内联表单（goal、urls、maxSteps 等），替代跳转 tasks.html
   - `Tasks.submitTask()` — 调用 `POST /v1/tasks/run`，提交后自动切换到结果视图
   - `Tasks.showResult(taskId)` — 调用 `GET /v1/tasks/:id`，展示状态/结果/事件流
   - `Tasks.pollStatus(taskId)` — 轮询运行中的任务状态

4. 修改 `switchView()` 函数支持 `'tasks'` 视图切换

5. CSS 新增 `.tasks-list`（卡片网格）、`.task-card`（状态色标）、`.task-detail`（详情面板）

6. 删除或保留 `tasks.html`/`task-result.html` 作为独立入口（向后兼容）

**验证**: 点击 Tasks tab 可查看任务列表，创建新任务，查看运行结果，全程不离开主页面。

---

## P2 批次：配置与持久化

### 2.1 Settings 连接测试按钮

**问题**: 用户填写 API Key / Base URL 后无法验证配置是否正确，只能等到运行 Agent 时才发现错误。

**修改文件**: `public/index.html`

**实现要点**:

1. Settings 弹窗中 Save 按钮旁新增 "Test Connection" 按钮
2. 点击后调用 `POST /v1/agent/run` 发送一个极简任务（如 `{ task: "test", maxIterations: 1 }`），或新增一个轻量的 `GET /v1/health` 端点验证 LLM 连通性
3. 显示测试结果：成功（绿色 ✓）/ 失败（红色 ✗ + 错误信息）
4. 测试期间按钮显示 loading 状态

**后端可选**: 在 `src/api/server.ts` 新增 `GET /v1/llm/test` 端点，接受 `apiKey`、`baseURL`、`model` 参数，发送一个最小 LLM 请求验证连通性，返回 `{ ok: true, model, latencyMs }` 或 `{ ok: false, error }`。

**验证**: 填写正确配置点击 Test 显示绿色成功；填写错误 API Key 显示红色错误信息。

### 2.2 聊天历史 localStorage 持久化

**问题**: 刷新页面后 Agent 聊天记录全部丢失，用户无法回顾之前的对话。

**修改文件**: `public/index.html`

**实现要点**:

1. 新增 `ChatStore` 对象：
   - `ChatStore.save()` — 将 `Agent.conversationHistory` + 聊天 DOM 的序列化版本存入 `localStorage`
   - `ChatStore.load()` — 页面加载时恢复聊天记录
   - `ChatStore.clear()` — `Agent.clearChat` 时清除存储
   - 存储 key: `ai-browser-chat-history`
   - 最大存储条数: 50 条消息（防止 localStorage 溢出）

2. 序列化格式：
```javascript
{
  messages: [{ type, content, iteration, extra, timestamp }],
  conversationHistory: [...],  // OpenAI 格式的对话历史
  savedAt: Date.now()
}
```

3. 触发时机：
   - `Agent.addMsg` 末尾调用 `ChatStore.save()`
   - `Agent.clearChat` 中调用 `ChatStore.clear()`
   - 页面 `DOMContentLoaded` 时调用 `ChatStore.load()`

4. 恢复时重建聊天 DOM（调用 `Agent.addMsg` 逐条渲染）

**验证**: 发送任务完成后刷新页面，聊天记录仍然可见。

### 2.3 截图刷新动画

**问题**: 截图更新时直接替换图片，用户无法感知"正在刷新"和"已更新"。

**修改文件**: `public/index.html`

**实现要点**:

1. CSS 新增截图过渡动画：
   - `.screenshot-loading` — 半透明遮罩 + 旋转 spinner
   - `.screenshot-updated` — 短暂边框闪烁（0.3s accent 色 glow）

2. 修改 `Agent.refreshScreenshot()`：
   - fetch 开始前：给截图容器添加 `.screenshot-loading`
   - fetch 成功后：移除 loading，添加 `.screenshot-updated`，300ms 后移除
   - fetch 失败：移除 loading，不做其他处理

**验证**: Agent 运行时截图区域有加载指示，更新后有短暂高亮反馈。

---

## P3 批次：扩展优化

### 3.1 移动端响应式优化

**问题**: 当前仅在 `<900px` 时堆叠面板，Agent 视图的左右分栏在平板上体验差。

**修改文件**: `public/index.html`

**实现要点**:

1. 增加 `@media (max-width: 768px)` 断点：
   - Agent 视图：聊天面板全宽，预览面板改为底部可拉起的抽屉
   - 导航栏：logo 缩短，tab 文字缩小
   - Settings 弹窗：全屏模式
   - 进度条信息：单行显示，省略 stepsRemaining

2. 增加 `@media (max-width: 480px)` 断点：
   - 隐藏预览面板，仅保留聊天
   - 工具结果默认折叠
   - 输入框高度增加（触摸友好）

**验证**: Chrome DevTools 模拟 iPad/iPhone 尺寸，各视图可正常使用。

### 3.2 Token 用量展示

**问题**: 后端 `done` 事件已包含 `tokenUsage`（input/output/total），但前端未展示。

**修改文件**: `public/index.html`

**实现要点**:

1. 修改 `Agent.handleEvent` 中 `case 'done'`：
   - 从 `ev.tokenUsage` 提取 input/output/total
   - 在 "Total steps" 系统消息后追加 token 用量信息

2. 格式示例：
```
— Total steps: 8 | Tokens: 12,450 (in: 10,200 / out: 2,250) —
```

3. 合并到现有的 `system` 消息中，不单独占行

**验证**: Agent 任务完成后，底部系统消息显示步数和 token 用量。

---

## 依赖关系

```
P1（核心体验）— 无外部依赖，可立即开始
  1.1 进度条 ← 依赖后端 progress 事件（已实现）
  1.2 工具人性化 ← 无依赖
  1.3 Task 集成 ← 依赖后端 /v1/tasks API（已实现）

P2（配置与持久化）— 可与 P1 并行
  2.1 连接测试 ← 可选依赖新增后端 /v1/llm/test 端点
  2.2 聊天持久化 ← 无依赖
  2.3 截图动画 ← 无依赖

P3（扩展优化）← 建议在 P1 完成后开始
  3.1 移动端 ← 依赖 P1 的 DOM 结构变更
  3.2 Token 展示 ← 依赖后端 tokenUsage（已实现）
```

## 文件修改汇总

| 文件 | 修改内容 | 批次 |
|------|----------|------|
| `public/index.html` | 进度条、工具人性化、Tasks 视图、连接测试、聊天持久化、截图动画、响应式、Token 展示 | P1-P3 |
| `src/api/server.ts` | 新增 `GET /v1/llm/test` 端点（可选） | P2 |
| `docs/05-roadmap.md` | 已更新：新增 Phase 5.5 + Phase 6 | — |
| `CLAUDE.md` | 已更新：MCP 工具数 + Agent 模块描述 | — |

## 验证方案

每个批次完成后：
1. 手动测试：启动 `npm run dev`，在浏览器中验证每项改进
2. 跨浏览器：Chrome + Firefox 基本验证
3. 回归：确认 Semantic 视图和现有 Agent 功能不受影响
4. P3 额外：Chrome DevTools 设备模拟验证响应式
