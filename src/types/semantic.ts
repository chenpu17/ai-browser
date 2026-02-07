import { ActionType } from './enums.js';
import { Rect, ElementState, ElementRelation } from './structures.js';

// 语义元素
export interface SemanticElement {
  id: string;
  type: string;
  label: string;
  actions: ActionType[];
  state: ElementState;
  region: string;
  bounds: Rect;
  relations?: ElementRelation[];
}
