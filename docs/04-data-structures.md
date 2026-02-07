# 数据结构定义

## 核心类型

### 1. 页面语义 (PageSemantic)

```typescript
interface PageSemantic {
  // 页面基础信息
  page: PageInfo;

  // 页面意图
  intents: Intent[];

  // 可交互元素
  elements: SemanticElement[];

  // 页面区域
  regions: Region[];

  // 页面状态
  state: PageState;
}

interface PageInfo {
  url: string;
  title: string;
  pageType: PageType;
  summary: string;
}
```

### 2. 意图 (Intent)

```typescript
interface Intent {
  // 意图动作
  action: string;

  // 置信度 0-1
  confidence: number;

  // 完成该意图需要的元素
  requiredElements: string[];

  // 意图描述
  description?: string;
}
```

常见意图：

| action | 描述 |
|--------|------|
| search | 搜索内容 |
| login | 用户登录 |
| register | 用户注册 |
| send_email | 发送邮件 |
| submit_form | 提交表单 |
| checkout | 结账支付 |

### 3. 语义元素 (SemanticElement)

```typescript
// 操作类型
type ActionType = 'click' | 'type' | 'clear' | 'select' | 'check' | 'scroll' | 'hover' | 'focus' | 'submit' | 'upload';

interface SemanticElement {
  id: string;
  type: ElementType;
  label: string;
  actions: ActionType[];
  state: ElementState;
  region: string;
  bounds: Rect;
  relations?: ElementRelation[];
}

// 元素关系
interface ElementRelation {
  type: 'label_for' | 'described_by' | 'controls' | 'contains';
  targetId: string;
}

interface ElementState {
  visible: boolean;
  enabled: boolean;
  focused: boolean;
  checked?: boolean;
  value?: string;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
```

### 4. 区域 (Region)

```typescript
interface Region {
  id: string;
  type: RegionType;
  bounds: Rect;
  elements: string[];
}

enum RegionType {
  HEADER = 'header',
  NAVIGATION = 'navigation',
  MAIN = 'main',
  SIDEBAR = 'sidebar',
  FOOTER = 'footer',
  MODAL = 'modal',
  FORM = 'form'
}
```

### 5. 页面状态 (PageState)

```typescript
interface PageState {
  loadState: LoadState;
  isReady: boolean;
  networkPending: number;
  domStable: boolean;
  modals: ModalInfo[];
  errors: string[];
}

interface ModalInfo {
  id: string;
  title: string;
  blocking: boolean;
}
```

### 6. 内容块与注意力分值 (ContentSection)

ContentExtractor 提取页面内容时，将页面拆分为带注意力分值的内容块，模拟人类浏览网页时的注意力分布。

```typescript
interface ContentSection {
  // 语义标签：h1, h2, p, li, blockquote 等
  tag: string;

  // 文本内容（最长 500 字符）
  text: string;

  // 注意力分值 0-1，越高表示越值得关注
  attention: number;
}
```

#### 6.1 ExtractedContent 结构

```typescript
interface ExtractedContent {
  title: string;
  sections: ContentSection[];  // 按 attention 降序排列，最多 50 个
  links: Array<{ text: string; url: string }>;
  images: Array<{ alt: string; src: string }>;
  metadata: Record<string, string>;
}
```

#### 6.2 注意力计算算法

对每个块级内容节点（h1-h6, p, li, blockquote, td, pre 等），综合四个维度计算注意力分值：

```
attention = 0.35 * positionScore
          + 0.25 * areaScore
          + 0.15 * fontSizeScore
          + 0.25 * semanticScore
```

| 维度 | 权重 | 计算方式 |
|------|------|----------|
| 位置 | 0.35 | 元素中心到视口中心的距离，越近分越高；首屏内额外 +0.2 |
| 面积 | 0.25 | `width * height / viewportArea`，归一化到 0-1 |
| 字号 | 0.15 | `fontSize / maxFontSize`，归一化到 0-1 |
| 语义 | 0.25 | 按标签固定分：h1=1.0, h2=0.85, h3=0.7, blockquote=0.6, p=0.5, li=0.4, td=0.3 |

#### 6.3 注意力等级标记

Agent 向 LLM 输出时，将数值分值转换为直观的星级标记：

| 分值范围 | 标记 | 含义 |
|----------|------|------|
| >= 0.7 | ★★★ | 高关注：标题、核心段落 |
| >= 0.4 | ★★ | 中等关注：正文内容 |
| < 0.4 | ★ | 低关注：边栏、页脚等 |

### 7. 模型扩展接口

支持接入外部模型增强语义理解：

```typescript
interface SemanticModelAdapter {
  name: string;

  // 增强页面理解
  enhancePageUnderstanding(
    raw: RawPageData
  ): Promise<PageUnderstanding>;

  // 增强元素标签
  enhanceElementLabels(
    elements: SemanticElement[]
  ): Promise<SemanticElement[]>;
}
```
