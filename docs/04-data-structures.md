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

### 6. 模型扩展接口

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
