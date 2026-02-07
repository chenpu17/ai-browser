import { ActionType, PageType, LoadState } from './enums.js';

// 矩形区域
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// 元素状态
export interface ElementState {
  visible: boolean;
  enabled: boolean;
  focused: boolean;
  checked?: boolean;
  value?: string;
}

// 元素关系
export interface ElementRelation {
  type: 'label_for' | 'described_by' | 'controls' | 'contains';
  targetId: string;
}

// 页面区域
export interface Region {
  name: string;
  role: string;
  bounds: Rect;
}

// 页面意图
export interface Intent {
  name: string;
  description: string;
  requiredElements: string[];
}
