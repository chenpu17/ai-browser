// 操作类型
export type ActionType = 'click' | 'type' | 'clear' | 'select' | 'check' | 'scroll' | 'hover' | 'focus' | 'submit' | 'upload';

// 页面类型
export enum PageType {
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

// 加载状态
export enum LoadState {
  LOADING = 'loading',
  INTERACTIVE = 'interactive',
  COMPLETE = 'complete',
  ERROR = 'error'
}
