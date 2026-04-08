/**
 * Manages conversation history with compression to prevent token explosion.
 * Keeps system prompt + recent messages intact, compresses older tool results.
 */
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';

export interface ConversationManagerOptions {
  maxMessages?: number;
  compressThreshold?: number;
  keepRecent?: number;
}

const DEFAULT_MAX_MESSAGES = 40;
const DEFAULT_COMPRESS_THRESHOLD = 30;
const DEFAULT_KEEP_RECENT = 20;
const CHARS_PER_TOKEN = 4; // rough heuristic
const DEFAULT_RESULT_LIMIT = 80;
const CONTENT_BEARING_RESULT_LIMIT = 400;
const DEFAULT_SUMMARY_LIMIT = 120;
const CONTENT_BEARING_SUMMARY_LIMIT = 420;
// These tools return larger text or structured payloads that the agent may need
// later for extraction, repair, or artifact follow-up. Keep more context for them.
const CONTENT_BEARING_TOOLS = new Set([
  'get_page_info',
  'get_page_content',
  'navigate_and_extract',
  'get_artifact',
  'get_task_run',
  'list_task_templates',
]);

function compactToolContent(content: string, limit: number): string {
  if (content.length <= limit) return content;
  const head = Math.max(40, Math.floor(limit * 0.65));
  const tail = Math.max(20, limit - head - 5);
  return `${content.slice(0, head)} … ${content.slice(-tail)}`;
}

export class ConversationManager {
  private messages: ChatCompletionMessageParam[] = [];
  private maxMessages: number;
  private compressThreshold: number;
  private keepRecent: number;

  constructor(options?: ConversationManagerOptions) {
    this.maxMessages = options?.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.compressThreshold = options?.compressThreshold ?? DEFAULT_COMPRESS_THRESHOLD;
    this.keepRecent = options?.keepRecent ?? DEFAULT_KEEP_RECENT;
  }

  /**
   * Initialize with system prompt and optional initial messages.
   * - Merges any system-role messages into the main system prompt (avoids mid-conversation system messages)
   * - Strips trailing orphaned tool_calls without matching tool results
   */
  init(systemPrompt: string, initialMessages: ChatCompletionMessageParam[], userTask: string): void {
    const extraSystemParts: string[] = [];
    const filtered: ChatCompletionMessageParam[] = [];

    for (const msg of initialMessages) {
      if (msg.role === 'system') {
        if (typeof msg.content === 'string') extraSystemParts.push(msg.content);
      } else {
        filtered.push(msg);
      }
    }

    // Strip trailing orphaned messages: assistant with tool_calls lacking results,
    // or tool messages without a matching assistant tool_calls (matched by tool_call_id).
    while (filtered.length > 0) {
      const last = filtered[filtered.length - 1];
      if (last.role === 'assistant' && 'tool_calls' in last && last.tool_calls?.length) {
        filtered.pop();
      } else if (last.role === 'tool') {
        const toolCallId = 'tool_call_id' in last ? (last as any).tool_call_id : undefined;
        const hasMatchingAssistant = toolCallId
          ? filtered.some(
              (m, idx) =>
                idx < filtered.length - 1 &&
                m.role === 'assistant' &&
                Array.isArray((m as any).tool_calls) &&
                (m as any).tool_calls.some((tc: any) => tc?.id === toolCallId),
            )
          : false;
        if (!hasMatchingAssistant) filtered.pop();
        else break;
      } else {
        break;
      }
    }

    const fullSystem = extraSystemParts.length > 0
      ? systemPrompt + '\n\n' + extraSystemParts.join('\n\n')
      : systemPrompt;

    this.messages = [
      { role: 'system', content: fullSystem },
      ...filtered,
      { role: 'user', content: userTask },
    ];
  }

  /**
   * Add a message to the conversation.
   */
  push(message: ChatCompletionMessageParam): void {
    this.messages.push(message);
    if (this.messages.length > this.compressThreshold) {
      this.compress();
    }
  }

  /**
   * Get all messages for LLM consumption.
   */
  getMessages(): ChatCompletionMessageParam[] {
    return this.messages;
  }

  /**
   * Get current message count.
   */
  get length(): number {
    return this.messages.length;
  }

  /**
   * Estimate total token count (~4 chars per token).
   */
  estimateTokens(): number {
    let chars = 0;
    for (const msg of this.messages) {
      if (typeof msg.content === 'string') {
        chars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if ('text' in part && typeof part.text === 'string') {
            chars += part.text.length;
          }
        }
      }
    }
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }

  /**
   * Compress older messages to stay within bounds.
   * Strategy: keep system prompt (index 0) + keepRecent most recent messages.
   * Middle messages get compressed: tool results become one-line summaries,
   * consecutive tool_call + tool_result pairs become grouped summaries.
   */
  private compress(): void {
    if (this.messages.length <= this.keepRecent + 1) return;

    const systemMsg = this.messages[0]; // always keep system prompt
    let recentStart = this.messages.length - this.keepRecent;

    // Adjust split point to avoid breaking tool_calls + tool message groups.
    // If recentStart lands on a 'tool' message, walk backwards to include
    // the matching assistant message with tool_calls.
    while (recentStart > 1 && this.messages[recentStart].role === 'tool') {
      recentStart--;
    }

    const middleMessages = this.messages.slice(1, recentStart);
    const recentMessages = this.messages.slice(recentStart);

    // Compress middle messages into a summary
    const summary = this.compressMessages(middleMessages);

    this.messages = [
      systemMsg,
      { role: 'user', content: `[对话历史摘要] ${summary}` },
      ...recentMessages,
    ];
  }

  private compressMessages(messages: ChatCompletionMessageParam[]): string {
    const parts: string[] = [];
    let i = 0;

    while (i < messages.length) {
      const msg = messages[i];

      if (msg.role === 'assistant' && Array.isArray((msg as any).tool_calls) && (msg as any).tool_calls.length > 0) {
        // Group assistant tool_calls with their tool results
        const toolNames = (msg as any).tool_calls.map((tc: any) => tc?.function?.name).filter(Boolean);
        if (toolNames.length === 0) toolNames.push('unknown');
        const thinking = typeof msg.content === 'string' && msg.content ? msg.content : '';

        // Collect subsequent tool results
        const results: string[] = [];
        const resultLimit = toolNames.some((name: string) => CONTENT_BEARING_TOOLS.has(name))
          ? CONTENT_BEARING_RESULT_LIMIT
          : DEFAULT_RESULT_LIMIT;
        let j = i + 1;
        while (j < messages.length && messages[j].role === 'tool') {
          const rawContent = messages[j].content;
          const content = typeof rawContent === 'string' ? rawContent : '';
          results.push(compactToolContent(content, resultLimit));
          j++;
        }

        const thinkPart = thinking ? `思考:"${thinking.slice(0, 60)}" ` : '';
        const summaryLimit = resultLimit > DEFAULT_RESULT_LIMIT
          ? CONTENT_BEARING_SUMMARY_LIMIT
          : DEFAULT_SUMMARY_LIMIT;
        parts.push(`${thinkPart}调用 ${toolNames.join(',')} → ${results.join('; ').slice(0, summaryLimit)}`);
        i = j;
        continue;
      }

      if (msg.role === 'user' && typeof msg.content === 'string') {
        parts.push(`用户: ${msg.content.slice(0, 80)}`);
      } else if (msg.role === 'system' && typeof msg.content === 'string') {
        parts.push(`系统: ${msg.content.slice(0, 60)}`);
      } else if (msg.role === 'assistant' && typeof msg.content === 'string') {
        parts.push(`助手: ${msg.content.slice(0, 80)}`);
      }

      i++;
    }

    return parts.join(' | ');
  }
}
