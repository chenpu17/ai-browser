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

// 弹窗信息
export interface DialogInfo {
  id: string;
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultValue?: string;
  timestamp: number;
  handled: boolean;
  response?: string | boolean;
}

// 网络请求日志
export interface NetworkLogEntry {
  id: string;
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  resourceType: string;
  responseSize?: number;
  timing?: { startTime: number; endTime?: number; duration?: number };
  headers?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  error?: string;
  isXHR: boolean;
}

// 控制台日志
export interface ConsoleLogEntry {
  level: 'error' | 'warn' | 'log' | 'info' | 'debug';
  text: string;
  timestamp: number;
  source?: string;
  lineNumber?: number;
}

// 下载信息
export interface DownloadInfo {
  id: string;
  url: string;
  filename: string;
  path: string;
  size?: number;
  completed: boolean;
  error?: string;
}
