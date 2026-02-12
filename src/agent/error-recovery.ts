/**
 * Smart error recovery strategies based on error type.
 */

export type RecoveryAction =
  | { type: 'retry'; delayMs: number }
  | { type: 'inject_hint'; message: string }
  | { type: 'abort'; reason: string };

interface ErrorContext {
  errorCode?: string;
  errorMessage: string;
  toolName: string;
  consecutiveErrors: number;
}

const MAX_RETRY_DELAY = 16000;

/**
 * Determine recovery action based on error context.
 */
export function determineRecovery(ctx: ErrorContext): RecoveryAction {
  const { errorCode, errorMessage, consecutiveErrors } = ctx;

  // Fatal errors — abort immediately
  if (errorCode === 'PAGE_CRASHED' || errorCode === 'SESSION_NOT_FOUND') {
    return { type: 'abort', reason: `不可恢复的错误: ${errorMessage}` };
  }

  // Element not found — hint to refresh
  if (errorCode === 'ELEMENT_NOT_FOUND') {
    return {
      type: 'inject_hint',
      message: '元素未找到，ID 可能已过期。请调用 get_page_info 刷新元素列表后重试。',
    };
  }

  // Navigation timeout — exponential backoff + hint
  if (errorCode === 'NAVIGATION_TIMEOUT') {
    const delay = Math.min(2000 * Math.pow(2, consecutiveErrors - 1), MAX_RETRY_DELAY);
    if (consecutiveErrors >= 3) {
      return {
        type: 'inject_hint',
        message: '导航多次超时。页面可能已部分加载，请尝试 wait_for_stable 或直接用 get_page_info 检查当前页面状态。',
      };
    }
    return { type: 'retry', delayMs: delay };
  }

  // Execution error — hint
  if (errorCode === 'EXECUTION_ERROR') {
    return {
      type: 'inject_hint',
      message: 'JavaScript 执行失败。请检查脚本语法，确保使用 return 返回数据。',
    };
  }

  // Invalid parameter — hint
  if (errorCode === 'INVALID_PARAMETER') {
    return {
      type: 'inject_hint',
      message: `参数错误: ${errorMessage}。请检查参数后重试。`,
    };
  }

  // LLM API errors — exponential backoff
  if (isLLMError(errorMessage)) {
    const delay = Math.min(2000 * Math.pow(2, consecutiveErrors - 1), MAX_RETRY_DELAY);
    return { type: 'retry', delayMs: delay };
  }

  // Default: exponential backoff for unknown errors
  const delay = Math.min(2000 * Math.pow(2, consecutiveErrors - 1), MAX_RETRY_DELAY);
  return { type: 'retry', delayMs: delay };
}

function isLLMError(message: string): boolean {
  const patterns = ['ECONNREFUSED', 'ETIMEDOUT', 'rate limit', '429', '500', '502', '503'];
  const lower = message.toLowerCase();
  return patterns.some(p => lower.includes(p.toLowerCase()));
}

/**
 * Extract errorCode from MCP tool result text.
 */
export function extractErrorCode(rawText: string): string | undefined {
  try {
    const data = JSON.parse(rawText);
    return data.errorCode || undefined;
  } catch {
    return undefined;
  }
}
