# 语义引擎设计

## 概述

语义引擎是 AI Browser 的核心，负责将浏览器的原始输出转换为 AI 友好的语义表示。

## 数据流

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  原始数据   │ ──▶ │  语义处理   │ ──▶ │  语义输出   │
│  采集      │     │             │     │             │
└─────────────┘     └─────────────┘     └─────────────┘
      │                   │                   │
      ▼                   ▼                   ▼
 AXTree + DOM        分析/增强           结构化 JSON
```

## 模块设计

### 1. 输入采集器 (InputCollector)

从 Chromium 采集原始数据：

```typescript
interface RawPageData {
  // Accessibility Tree
  axTree: AXNode[];

  // DOM 结构
  domSnapshot: DOMSnapshot;

  // 布局信息
  layoutMetrics: LayoutMetrics;

  // 元素边界
  elementBounds: Map<string, Rect>;

  // 页面元信息
  metadata: {
    url: string;
    title: string;
    favicon: string;
  };
}
```

采集方式（通过 CDP）：

| 数据 | CDP 方法 |
|------|----------|
| AXTree | `Accessibility.getFullAXTree` |
| DOM | `DOMSnapshot.captureSnapshot` |
| 布局 | `Page.getLayoutMetrics` |
| 边界 | `DOM.getBoxModel` |

### 2. 页面理解器 (PageAnalyzer)

识别页面类型和意图：

```typescript
interface PageUnderstanding {
  // 页面类型
  pageType: PageType;

  // 页面可执行的意图
  intents: Intent[];

  // 页面区域划分
  regions: Region[];

  // 页面摘要（一句话描述）
  summary: string;
}
```

#### 2.1 页面类型定义

```typescript
enum PageType {
  SEARCH_ENGINE = 'search_engine',
  SEARCH_RESULTS = 'search_results',
  LOGIN = 'login',
  REGISTER = 'register',
  FORM = 'form',
  ARTICLE = 'article',
  LIST = 'list',
  EMAIL_COMPOSE = 'email_compose',
  EMAIL_INBOX = 'email_inbox',
  DASHBOARD = 'dashboard',
  SETTINGS = 'settings',
  CHECKOUT = 'checkout',
  UNKNOWN = 'unknown'
}
```

#### 2.2 页面类型识别规则

| 信号类型 | 示例 | 权重 |
|----------|------|------|
| URL 模式 | `/login`, `/signin`, `?q=` | 高 |
| 表单特征 | password 字段、验证码 | 高 |
| 元素统计 | 大量列表项、长文本块 | 中 |
| 文本关键词 | "登录"、"搜索结果"、"收件箱" | 中 |
| 页面结构 | header/main/sidebar 比例 | 低 |

### 3. 元素索引器 (ElementIndexer)

构建可交互元素的语义索引：

```typescript
interface SemanticElement {
  // 语义 ID（稳定、可读）
  id: string;

  // 元素类型
  type: ElementType;

  // 显示标签
  label: string;

  // 可执行的操作
  actions: Action[];

  // 当前状态
  state: ElementState;

  // 所属区域
  region: string;

  // 位置信息
  bounds: Rect;

  // 关联元素
  relations?: ElementRelation[];
}
```

#### 3.1 元素类型

```typescript
enum ElementType {
  BUTTON = 'button',
  LINK = 'link',
  TEXT_INPUT = 'text_input',
  PASSWORD_INPUT = 'password_input',
  TEXTAREA = 'textarea',
  CHECKBOX = 'checkbox',
  RADIO = 'radio',
  SELECT = 'select',
  FILE_INPUT = 'file_input',
  IMAGE = 'image',
  VIDEO = 'video',
  TAB = 'tab',
  MENU_ITEM = 'menu_item',
  LIST_ITEM = 'list_item'
}
```

#### 3.2 语义 ID 生成规则

目标：生成稳定、可读、唯一的 ID

```
优先级：
1. aria-label / aria-labelledby
2. 可见文本内容
3. placeholder / title
4. name 属性
5. 元素类型 + 序号
```

示例：
| 元素 | 生成的 ID |
|------|-----------|
| `<button>登录</button>` | `btn_登录` |
| `<input placeholder="搜索">` | `input_搜索` |
| `<a>了解更多</a>` | `link_了解更多` |
| `<button aria-label="关闭">×</button>` | `btn_关闭` |

#### 3.3 ID 冲突处理

当多个元素生成相同 ID 时（如多个"删除"按钮）：

```typescript
function resolveIdConflict(baseId: string, context: ElementContext): string {
  // 1. 使用父级区域消歧
  if (context.region) {
    return `${baseId}_in_${context.region}`;
  }
  // 2. 使用相邻元素消歧
  if (context.siblingText) {
    return `${baseId}_near_${context.siblingText}`;
  }
  // 3. 使用序号
  return `${baseId}_${context.index}`;
}
```

示例：
| 场景 | 生成的 ID |
|------|-----------|
| 第一行的删除按钮 | `btn_删除_in_row_1` |
| 商品A旁的删除 | `btn_删除_near_商品A` |

#### 3.4 稳定句柄机制

语义ID可能因页面变化而漂移，引入内部稳定句柄：

```typescript
interface ElementHandle {
  semanticId: string;      // 语义ID（可读）
  backendNodeId: number;   // CDP 内部节点ID（稳定）
  revision: number;        // 页面版本号
}
```

操作时优先使用 backendNodeId 定位，semanticId 用于展示和日志。

### 3.5 内容提取器 (ContentExtractor)

提取页面文本内容，并为每个内容块计算注意力分值，模拟人类浏览网页时的注意力分布。

```
页面 DOM
    ↓
遍历块级内容节点 (h1-h6, p, li, blockquote, td, pre 等)
    ↓
过滤隐藏/不可见元素
    ↓
对每个节点计算四维注意力分值
    ↓
按 attention 降序排列，截取前 50 个
    ↓
输出 ContentSection[]
```

四维注意力模型：

| 维度 | 权重 | 说明 |
|------|------|------|
| 位置 (position) | 0.35 | 元素中心到视口中心的距离；首屏加分 |
| 面积 (area) | 0.25 | 元素占视口面积比例 |
| 字号 (fontSize) | 0.15 | 相对于页面最大字号的比例 |
| 语义 (semantic) | 0.25 | 按 HTML 标签固定分值 |

详细数据结构见 `04-data-structures.md` 第 6 节。

### 4. 状态追踪器 (StateTracker)

追踪页面状态变化：

```typescript
// 内部详细状态（用于就绪判断）
interface InternalPageState {
  loadState: LoadState;
  networkActivity: {
    pendingRequests: number;
    lastRequestTime: number;
  };
  domStability: {
    isStable: boolean;
    lastMutationTime: number;
    mutationCount: number;
  };
  modals: ModalInfo[];
  errors: string[];
}

// 对外状态（见 04-data-structures.md PageState）
// 由 InternalPageState 转换而来
```

#### 4.1 智能就绪判断

采用"静默窗口"模型，避免长轮询/动画页面死锁：

```typescript
interface ReadyConfig {
  quietWindowMs: 500;      // 静默窗口时间
  maxWaitMs: 10000;        // 最大等待时间
  allowPendingRequests: 2; // 允许的后台请求数
}

function isPageReady(state: InternalPageState, config: ReadyConfig): boolean {
  const now = Date.now();
  const quietPeriod = now - state.domStability.lastMutationTime;

  // 基础条件
  const basicReady = state.loadState !== 'loading';
  // 静默窗口：DOM 在指定时间内无变化
  const domQuiet = quietPeriod >= config.quietWindowMs;
  // 网络允许少量后台请求
  const networkOk = state.networkActivity.pendingRequests <= config.allowPendingRequests;

  return basicReady && domQuiet && networkOk;
}
```

### 5. 操作执行器 (ActionExecutor)

接收语义化指令，执行操作：

```typescript
interface ActionRequest {
  // 操作类型
  action: ActionType;

  // 目标元素（语义 ID 或描述）
  target: string;

  // 操作参数
  params?: Record<string, any>;
}

enum ActionType {
  CLICK = 'click',
  TYPE = 'type',
  SELECT = 'select',
  CHECK = 'check',
  SCROLL = 'scroll',
  HOVER = 'hover',
  FOCUS = 'focus',
  SUBMIT = 'submit',
  UPLOAD = 'upload'
}
```

#### 5.1 元素定位策略

```
语义 ID → 精确匹配
    ↓ 失败
文本描述 → 模糊匹配（标签、placeholder）
    ↓ 失败
返回候选列表，让 AI 选择
```

候选列表结构：
```typescript
interface CandidateList {
  query: string;
  candidates: Array<{
    id: string;
    label: string;
    score: number;  // 匹配分数 0-1
  }>;
}
```

#### 5.2 操作结果

```typescript
interface ActionResult {
  success: boolean;
  // 操作后的页面变化
  changes?: {
    urlChanged: boolean;
    newUrl?: string;
    domMutations: number;
    newModals: ModalInfo[];
  };
  error?: string;
}
```

### 6. iframe 处理器 (IframeHandler)

处理嵌套 iframe 中的内容：

```typescript
interface FrameInfo {
  id: string;
  url: string;
  bounds: Rect;
  isVisible: boolean;
}

interface IframeHandler {
  // 检测页面中的 iframe
  detectFrames(): FrameInfo[];

  // 切换到指定 frame
  switchToFrame(frameId: string): Promise<void>;

  // 返回主 frame
  switchToMain(): Promise<void>;

  // 获取 frame 内的语义
  getFrameSemantic(frameId: string): Promise<PageSemantic>;
}
```

#### 6.1 iframe 处理策略

```
页面加载完成
    ↓
检测所有 iframe
    ↓
过滤不可见/广告 iframe
    ↓
为每个有效 iframe 生成语义
    ↓
合并到主页面语义（带 frame 前缀）
```

元素 ID 格式：`frame_{frameId}_{elementId}`

#### 6.2 跨域 iframe 限制

由于浏览器安全策略：

| iframe 类型 | 可获取内容 |
|-------------|-----------|
| 同源 | 完整语义（元素、状态） |
| 跨域 | 仅 bounds、url，内容标记为 `cross_origin_restricted` |

### 7. 动态内容处理器 (DynamicContentHandler)

处理懒加载、无限滚动等动态内容：

```typescript
interface DynamicContentHandler {
  // 检测懒加载区域
  detectLazyLoadRegions(): Region[];

  // 触发内容加载
  triggerLoad(region: Region): Promise<void>;

  // 无限滚动采集
  scrollAndCollect(options: ScrollOptions): Promise<SemanticElement[]>;
}

interface ScrollOptions {
  maxScrolls: number;
  scrollDelay: number;
  stopCondition?: (elements: SemanticElement[]) => boolean;
}
```
