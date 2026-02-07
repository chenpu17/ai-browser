import { LoadState } from './enums.js';

// 模态框信息
export interface ModalInfo {
  id: string;
  title: string;
  blocking: boolean;
}

// 页面状态（对外）
export interface PageState {
  loadState: LoadState;
  isReady: boolean;
  networkPending: number;
  domStable: boolean;
  modals: ModalInfo[];
  errors: string[];
}
