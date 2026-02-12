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

    // Strip trailing assistant message with tool_calls if no matching tool results follow
    while (filtered.length > 0) {
      const last = filtered[filtered.length - 1];
      if (last.role === 'assistant' && 'tool_calls' in last && last.tool_calls?.length) {
        filtered.pop();
      } else if (last.role === 'tool') {
        // Check if there's a matching assistant tool_calls before this tool message
        const hasMatchingAssistant = filtered.some(
          (m, idx) => idx < filtered.length - 1 && m.role === 'assistant' && 'tool_calls' in m,
        );
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
    const recentStart = this.messages.length - this.keepRecent;
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

      if (msg.role === 'assistant' && 'tool_calls' in msg && msg.tool_calls) {
        // Group assistant tool_calls with their tool results
        const toolNames = msg.tool_calls.map((tc: any) => tc.function?.name || 'unknown');
        const thinking = typeof msg.content === 'string' && msg.content ? msg.content : '';

        // Collect subsequent tool results
        const results: string[] = [];
        let j = i + 1;
        while (j < messages.length && messages[j].role === 'tool') {
          const rawContent = messages[j].content;
          const content = typeof rawContent === 'string' ? rawContent : '';
          results.push(content.slice(0, 80));
          j++;
        }

        const thinkPart = thinking ? `思考:"${thinking.slice(0, 60)}" ` : '';
        parts.push(`${thinkPart}调用 ${toolNames.join(',')} → ${results.join('; ').slice(0, 120)}`);
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
