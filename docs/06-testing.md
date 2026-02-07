# 自动化测试设计

## 概述

通过 AI 对比验证语义输出的准确性，实现自动化质量评估。

## 测试流程

```
┌─────────────────────────────────────────────────────────────┐
│                     测试流程                                 │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   输入: URL                                                 │
│      │                                                      │
│      ▼                                                      │
│   ┌─────────────────────────────────────────────────────┐   │
│   │              AI Browser 处理                         │   │
│   │                                                     │   │
│   │  ┌─────────────┐         ┌─────────────┐           │   │
│   │  │  语义输出   │         │  原始输出   │           │   │
│   │  │  (JSON)     │         │  (截图+DOM) │           │   │
│   │  └──────┬──────┘         └──────┬──────┘           │   │
│   │         │                       │                   │   │
│   └─────────┼───────────────────────┼───────────────────┘   │
│             │                       │                       │
│             ▼                       ▼                       │
│   ┌─────────────────────────────────────────────────────┐   │
│   │              AI 验证器                               │   │
│   │                                                     │   │
│   │  对比语义输出与原始输出，评估准确性                  │   │
│   │                                                     │   │
│   └──────────────────────┬──────────────────────────────┘   │
│                          │                                  │
│                          ▼                                  │
│   ┌─────────────────────────────────────────────────────┐   │
│   │              测试报告                                │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## 测试输入输出

### 输入

```typescript
interface TestInput {
  url: string;
  // 可选：预期的页面类型
  expectedPageType?: PageType;
  // 可选：预期的关键元素
  expectedElements?: string[];
}
```

### 输出（提供给 AI 验证器）

```typescript
interface TestData {
  // 语义输出
  semantic: PageSemantic;

  // 原始输出
  raw: {
    screenshot: string;      // base64 图片
    accessibilityTree: any;  // 原始 AXTree
    domSnapshot: any;        // DOM 快照
  };

  // 元信息
  meta: {
    url: string;
    timestamp: number;
  };
}
```

## AI 验证器

### 评估维度

| 维度 | 说明 | 评分 |
|------|------|------|
| 页面类型 | 识别的页面类型是否正确 | 0-1 |
| 元素完整性 | 是否识别了所有可交互元素 | 0-1 |
| 元素标签 | 元素标签是否准确描述功能 | 0-1 |
| 区域划分 | 页面区域划分是否合理 | 0-1 |
| 噪音过滤 | 是否正确过滤了广告等噪音 | 0-1 |

### 验证 Prompt 模板

```
你是 AI Browser 的质量验证器。

我会提供：
1. 页面截图
2. 原始 Accessibility Tree
3. AI Browser 输出的语义结构

请评估语义输出的准确性：

## 评估项

1. 页面类型识别
   - 语义输出的 pageType: {pageType}
   - 根据截图判断是否正确？

2. 元素完整性
   - 截图中可见的可交互元素有哪些？
   - 语义输出是否都包含了？
   - 是否有遗漏？

3. 元素标签准确性
   - 每个元素的 label 是否准确描述了其功能？

4. 噪音过滤
   - 是否正确排除了广告、装饰性元素？

## 输出格式

{
  "scores": {
    "pageType": 0.0-1.0,
    "elementCompleteness": 0.0-1.0,
    "labelAccuracy": 0.0-1.0,
    "noiseFiltering": 0.0-1.0
  },
  "issues": ["问题1", "问题2"],
  "suggestions": ["建议1", "建议2"]
}
```

## 测试报告

```typescript
interface TestReport {
  url: string;
  timestamp: number;
  scores: {
    pageType: number;
    elementCompleteness: number;
    labelAccuracy: number;
    noiseFiltering: number;
    overall: number;
  };
  issues: string[];
  suggestions: string[];
}
```

## 测试用例集

### 本地 Fixture（推荐）

使用本地静态页面，确保测试可重复：

```
fixtures/
├── search-page.html      # 搜索页模板
├── login-page.html       # 登录页模板
├── article-page.html     # 文章页模板
└── form-page.html        # 表单页模板
```

### 真实网站（可选）

仅用于手动验证，不纳入 CI：

| 类型 | 示例 URL | 验证重点 |
|------|----------|----------|
| 搜索引擎 | google.com | 搜索框识别 |
| 登录页 | github.com/login | 表单字段识别 |

## 测试金字塔

```
        /\
       /  \  E2E (AI 验证)
      /----\
     /      \  集成测试
    /--------\
   /          \  单元测试
  --------------
```

### 单元测试

各模块独立测试：

| 模块 | 测试内容 |
|------|----------|
| PageTypeClassifier | 页面类型识别准确性 |
| ElementIndexer | ID 生成、冲突处理 |
| StateTracker | 状态变化检测 |
| ActionExecutor | 操作执行正确性 |

### 集成测试

API + 语义引擎联合测试：

```typescript
describe('Integration', () => {
  it('navigate and get semantic', async () => {
    const session = await api.createSession();
    await api.navigate(session.id, 'https://example.com');
    const semantic = await api.getSemantic(session.id);
    expect(semantic.page.pageType).toBeDefined();
    expect(semantic.elements.length).toBeGreaterThan(0);
  });
});
```

### 性能测试

```typescript
interface PerformanceTargets {
  semanticExtractionLatency: 500;   // ms
  actionExecutionLatency: 200;      // ms
  concurrentSessions: 10;
  memoryPerSession: 200;            // MB
}
```
