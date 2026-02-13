# Site Memory 按需召回设计

## 问题

当前 Memory 注入方式（`agent-loop.ts:200-210`）在 agent 启动时将整张 KnowledgeCard 一次性塞入 system prompt：

```
systemPrompt += '\n\n' + MemoryInjector.buildContext(card);
```

存在三个问题：

1. **浪费上下文** — 如果 agent 不需要记忆（比如任务很简单），2000 字符白白占用
2. **单域名限制** — 只从任务文本提取一个域名，多域名任务（"从淘宝比价再去京东下单"）只能命中第一个
3. **静态注入** — agent 执行过程中导航到新域名时，无法获取该域名的记忆

## 设计目标

- Agent 按需查询记忆，零浪费
- 支持多域名：agent 每到一个新站点都可以查
- 与现有 MCP 工具体系一致，不引入新机制
- 向后兼容：外部 MCP 消费者也能使用

## 方案对比

| 维度 | A: MCP Tool（按需查询） | B: Progressive（按 turn 注入） |
|------|------------------------|-------------------------------|
| 触发方式 | Agent 主动调用 `recall_site_memory` | 每轮 tool call 后系统自动检查当前 URL |
| 上下文开销 | 仅在 agent 认为需要时消耗 | 每次域名变化都注入，可能冗余 |
| 多域名支持 | 天然支持，agent 可多次调用 | 支持，但被动触发 |
| 实现复杂度 | 低 — 加一个 MCP tool | 中 — 需要在 agent loop 里加 hook |
| Agent 自主性 | 高 — agent 决定何时查 | 低 — 系统替 agent 决定 |
| 外部可用性 | MCP 消费者也能用 | 仅 agent 内部 |

**选择方案 A**：MCP Tool。理由：更简单、更灵活、与 context7 查文档同一模式、外部 MCP 消费者也能受益。

## 工具设计

### `recall_site_memory`

```typescript
{
  name: 'recall_site_memory',
  description: '查询站点记忆。在调用 navigate 或 navigate_and_extract 进入新域名之前，先调用此工具获取该站点的历史经验（已知选择器、导航路径、操作流程等）。如果没有记忆则返回空，你需要自行探索。',
  inputSchema: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        description: '目标站点域名，如 bilibili.com、jd.com。如果不确定，可以从 URL 中提取。'
      },
      url: {
        type: 'string',
        description: '目标 URL（可选）。如果提供，会自动提取域名。'
      },
      task_hint: {
        type: 'string',
        description: '当前要执行的任务简述（可选）。用于筛选最相关的记忆条目。'
      }
    }
    // domain 和 url 至少提供一个，handler 中显式校验
  }
}
```

**输入校验**：handler 顶部显式校验 `domain` 和 `url` 至少提供一个，否则抛出 `invalidParameterError('domain or url is required')`。与现有工具（如 `click`、`type_text`）的校验模式一致。

**域名提取**：当提供 `url` 时，使用 `MemoryCapturer.extractDomain(url)` 提取域名（纯 URL 解析，`agent-loop.ts:233` 已在用）。不使用 `MemoryInjector.extractDomain()` — 后者是从自然语言任务文本中模糊匹配，不适用于已有明确 URL 的场景。当提供 `domain` 时，用 `isSafeDomain()` 校验后直接使用。

### 返回格式

```typescript
// 有记忆时
{
  found: true,
  domain: 'bilibili.com',
  siteType: 'spa',
  requiresLogin: false,
  patternCount: 12,
  patternTypes: { selector: 5, navigation_path: 2, task_intent: 3, spa_hint: 1, page_structure: 1 },
  context: '## 站点记忆: bilibili.com [SPA]\n### 已知任务经验\n- 任务: ...\n...',
  aiSummary: '已找到 bilibili.com 的站点记忆（12 条模式：5 选择器, 3 任务经验, 2 导航路径）。请参考历史经验操作，如页面结构已变化请忽略。'
}

// 无记忆时
{
  found: false,
  domain: 'bilibili.com',
  aiSummary: '没有 bilibili.com 的站点记忆。请自行探索页面结构。',
  aiHints: ['使用 get_page_info 探索页面结构', '使用 get_page_content 获取页面内容']
}
```

**context 大小**：沿用 `DEFAULT_MAX_CHARS = 2000` 上限。多域名场景下 agent 可能多次调用，累计 2000×N 字符进入对话。这是可接受的 — 每次调用的 context 会被 `content-budget.ts` 按工具类别截断，且 `conversation-manager.ts` 会自动压缩旧消息。不额外暴露 `maxChars` 参数，保持接口简洁。

### task_hint 筛选逻辑

当提供 `task_hint` 时，对 `task_intent` 类型的 pattern 做简单相关性排序。

**CJK 兼容方案**：不使用空格分词（中文无空格），改用子串包含匹配：

1. 对每条 `task_intent` 的 value，检查是否包含 `task_hint` 的任意连续子串（长度 ≥ 2 字符）
2. 匹配到的排在前面，按匹配子串长度降序
3. 未匹配的按原有置信度排序
4. 不做硬过滤 — 即使不相关的记忆也返回（agent 自己判断是否有用）

实现示例：
```typescript
function relevanceScore(intentValue: string, hint: string): number {
  let maxLen = 0;
  // 滑动窗口：从最长子串开始检查
  for (let len = hint.length; len >= 2; len--) {
    for (let i = 0; i <= hint.length - len; i++) {
      if (intentValue.includes(hint.slice(i, i + len))) {
        return len; // 返回最长匹配子串长度
      }
    }
  }
  return 0;
}
```

这是轻量级实现，不引入向量搜索。对于中文任务如 `task_hint="搜索视频"` 能正确匹配包含"搜索"或"视频"的 intent。

### aiMarkdown 集成

在 `src/mcp/ai-markdown.ts` 中注册 `recall_site_memory` 的 handler。tool handler 使用 `textResult(result, 'recall_site_memory')` 返回结果，与所有其他工具一致。

aiMarkdown 格式：
- 有记忆时：直接使用 `context` 字段（已经是 markdown 格式）
- 无记忆时：返回 `aiSummary` + `aiHints`

这确保 LLM 路径（`content-budget.ts`）和 Web UI 路径（`public/index.html`）都能正确渲染。

## Agent Prompt 变更

在 `SYSTEM_PROMPT` 中添加工具使用指引（不再在 system prompt 中注入记忆内容）：

```
## 站点记忆

在调用 navigate 或 navigate_and_extract 进入一个新域名之前，先调用 recall_site_memory 查询是否有该站点的历史经验。
- 必须在 navigate / navigate_and_extract 之前调用，不要到了页面再查
- 如果返回了记忆，优先参考已知的选择器和操作路径
- 如果页面结构与记忆不符，忽略记忆并重新探索
- 不要对每个页面都调用 — 只在进入新域名时调用一次即可
```

## 修改范围

### 1. `src/mcp/browser-mcp-server.ts` — 注册 MCP tool

新增 `recall_site_memory` 工具。需要访问 `KnowledgeCardStore` 实例。

注册位置：在 Composite Tools 之后、Task Runtime Tools 之前，新建 `// ===== Memory Tools =====` 分区。

```typescript
// ===== Memory Tools =====
server.tool(
  'recall_site_memory',
  '查询站点记忆。在 navigate 进入新域名之前调用...',
  {
    domain: z.string().optional().describe('目标站点域名'),
    url: z.string().optional().describe('目标 URL，自动提取域名'),
    task_hint: z.string().optional().describe('任务简述，用于筛选相关记忆'),
  },
  safe(async ({ domain, url, task_hint }) => {
    // 1. 校验：domain 和 url 至少提供一个
    if (!domain && !url) throw invalidParameterError('domain or url is required');
    // 2. 提取域名：url 用 MemoryCapturer.extractDomain()，domain 用 isSafeDomain() 校验
    // 3. 查询 knowledgeStore.loadCard(resolvedDomain)
    // 4. 如果有 task_hint，调用 MemoryInjector.buildContext(card, 2000, task_hint)
    // 5. 构建 patternTypes 统计
    // 6. return textResult(result, 'recall_site_memory')
  })
);
```

**KnowledgeCardStore 传递**：`createBrowserMcpServer()` 已接收 `sessionManager`，同样模式传入 `knowledgeStore`。

### 2. `src/mcp/ai-markdown.ts` — 注册 aiMarkdown handler

为 `recall_site_memory` 添加 aiMarkdown 格式化逻辑，确保 LLM 和 Web UI 两条消费路径都能正确渲染。

### 3. `src/agent/agent-loop.ts` — 移除 system prompt 注入

删除 L200-210 的 `MemoryInjector` system prompt 注入逻辑。Agent 改为通过工具调用获取记忆。

**注意**：`knowledgeStore` 仍需保留在 `BrowsingAgent` 构造函数中 — L220-245 的自动捕获逻辑（成功执行后保存 patterns）依赖它。仅移除注入路径，不移除捕获路径。

### 4. `src/agent/prompt.ts` — 添加工具使用指引

在 SYSTEM_PROMPT 中添加"站点记忆"段落，明确指引 agent 在 `navigate` / `navigate_and_extract` 之前调用 `recall_site_memory`。

### 5. `src/memory/MemoryInjector.ts` — 扩展 buildContext

添加可选的 `taskHint` 参数，支持按子串匹配相关性排序 task_intent：

```typescript
static buildContext(card: KnowledgeCard, maxChars = DEFAULT_MAX_CHARS, taskHint?: string): string {
  // 如果有 taskHint，对 task_intent 按子串匹配相关性排序
  // 其余逻辑不变
}
```

`extractDomain()` 保留但不在 tool handler 中使用（它是自然语言模糊匹配，tool handler 用 `MemoryCapturer.extractDomain()`）。

### 6. `CLAUDE.md` — 更新 MCP Tools 表

新增 **Memory Tools (1)** 分类（在 Composite Tools 和 Task Runtime Tools 之间），添加 `recall_site_memory`。

### 7. 不需要修改的文件

- `KnowledgeCardStore.ts` — 已有 `loadCard()`、`hasDomain()` 等接口，无需改动
- `MemoryCapturer.ts` — 自动捕获逻辑不变
- `RecordingConverter.ts` — 录制转换不变
- `public/index.html` — 前端无需感知此变更
- `src/api/routes.ts` — REST API 不变

## 迁移策略

一步到位，不做渐进迁移：
1. 注册 MCP tool + aiMarkdown handler
2. 删除 agent-loop.ts 中的 system prompt 注入（保留 knowledgeStore 构造参数和自动捕获逻辑）
3. 更新 agent prompt

不需要保留旧的注入方式 — 两种方式不应共存（会导致重复注入）。所有变更在同一次构建中生效，不存在中间状态。

## 后续演进

- **向量搜索**：当 task_intent 积累到一定量级，子串匹配不够用时，可引入 embedding 做语义匹配
- **跨域名记忆**：某些模式是跨站通用的（如"电商下单流程"），可以抽象为 meta-pattern
- **记忆失效检测**：agent 使用记忆中的 selector 失败时，自动降低该 pattern 的 confidence
- **MCP Resource 暴露**：将 memory 同时暴露为 MCP Resource，支持 IDE 侧边栏浏览
