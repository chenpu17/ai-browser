import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { config } from './config.js';
import { SYSTEM_PROMPT } from './prompt.js';
import type { AgentState, AgentRunResult, AgentEvent, InputField } from './types.js';
import { formatToolResult } from './content-budget.js';
import { ToolUsageTracker } from './tool-usage-tracker.js';
import { determineRecovery, extractErrorCode } from './error-recovery.js';
import { ConversationManager } from './conversation-manager.js';
import { TokenTracker } from './token-tracker.js';
import { PageStateCache } from './page-state-cache.js';
import { ProgressEstimator } from './progress-estimator.js';
import type { SubGoal } from './types.js';

export class BrowsingAgent extends EventEmitter {
  private openai: OpenAI;
  private mcpClient: Client;
  private state: AgentState;
  private conversation = new ConversationManager();
  private model: string;
  private maxIterations: number;
  private initialMessages: ChatCompletionMessageParam[];
  private tools: ChatCompletionTool[] = [];
  private toolTracker = new ToolUsageTracker();
  private tokenTracker = new TokenTracker();
  private pageStateCache = new PageStateCache();
  private progressEstimator: ProgressEstimator;
  private subGoals: SubGoal[] = [];
  private stepWarningInjected = false;
  private pendingInputResolve: ((response: Record<string, string>) => void) | null = null;
  private pendingInputRequestId: string | null = null;
  private _askHumanTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: {
    apiKey?: string;
    baseURL?: string;
    model?: string;
    mcpClient: Client;
    maxIterations?: number;
    initialMessages?: ChatCompletionMessageParam[];
    subGoals?: string[];
  }) {
    super();
    this.model = options.model || config.llm.model;
    this.openai = new OpenAI({
      baseURL: options.baseURL || config.llm.baseURL,
      apiKey: options.apiKey || config.llm.apiKey,
    });
    this.mcpClient = options.mcpClient;
    this.maxIterations = options.maxIterations ?? config.maxIterations;
    this.initialMessages = options.initialMessages || [];
    this.progressEstimator = new ProgressEstimator(this.maxIterations);
    if (options.subGoals?.length) {
      this.subGoals = options.subGoals.map(d => ({ description: d, completed: false }));
    }
    this.state = {
      sessionId: '',
      iteration: 0,
      consecutiveErrors: 0,
      done: false,
    };
  }

  get sessionId(): string {
    return this.state.sessionId;
  }

  resolveInput(requestId: string, response: Record<string, string>): boolean {
    if (this.pendingInputRequestId !== requestId || !this.pendingInputResolve) {
      return false;
    }
    // Clear the timeout timer to prevent resource leak
    if (this._askHumanTimer) {
      clearTimeout(this._askHumanTimer);
      this._askHumanTimer = null;
    }
    this.pendingInputResolve(response);
    this.pendingInputResolve = null;
    this.pendingInputRequestId = null;
    return true;
  }

  private emitEvent(event: AgentEvent): void {
    this.emit('event', event);
  }

  private async discoverTools(): Promise<void> {
    const { tools: mcpTools } = await this.mcpClient.listTools();
    // 过滤内部工具，不暴露给 LLM
    const INTERNAL_TOOLS = ['create_session', 'close_session'];
    this.tools = mcpTools
      .filter((t) => !INTERNAL_TOOLS.includes(t.name))
      .map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.inputSchema as any,
        },
      }));
    // Add the 'done' tool (agent-only, not from MCP)
    this.tools.push({
      type: 'function',
      function: {
        name: 'done',
        description: '任务完成时调用。报告最终结果并结束任务。',
        parameters: {
          type: 'object',
          properties: {
            result: { type: 'string', description: '任务的最终结果描述' },
          },
          required: ['result'],
        },
      },
    });
    // Add the 'ask_human' tool for requesting user input (e.g. login credentials)
    this.tools.push({
      type: 'function',
      function: {
        name: 'ask_human',
        description: '向用户请求信息（如登录凭据）。调用后会暂停等待用户输入。',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', description: '向用户提出的问题' },
            fields: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  label: { type: 'string' },
                  type: { type: 'string', enum: ['text', 'password'] },
                },
                required: ['name', 'label', 'type'],
              },
            },
          },
          required: ['question', 'fields'],
        },
      },
    });
    console.log(`[Agent] 发现 ${this.tools.length} 个工具`);
  }

  async run(task: string): Promise<AgentRunResult> {
    // Discover tools from MCP server
    await this.discoverTools();

    // Create session via MCP
    console.log('[Agent] 创建浏览器会话...');
    let sessionResult;
    try {
      sessionResult = await this.mcpClient.callTool({ name: 'create_session', arguments: {} });
      const text = (sessionResult.content as any)?.[0]?.text;
      if (!text) throw new Error('create_session returned no text content');
      const parsed = JSON.parse(text);
      this.state.sessionId = parsed.sessionId;
    } catch (err: any) {
      const result: AgentRunResult = { success: false, error: `创建会话失败: ${err.message}`, iterations: 0 };
      this.emitEvent({ type: 'done', success: false, error: result.error, iterations: 0 });
      return result;
    }
    console.log(`[Agent] 会话已创建: ${this.state.sessionId}`);
    this.emitEvent({ type: 'session_created', sessionId: this.state.sessionId });

    // Build messages: system + initialMessages (conversation memory) + user task
    let systemPrompt = SYSTEM_PROMPT;
    if (this.subGoals.length > 0) {
      const goalList = this.subGoals.map((g, i) => `${i + 1}. ${g.description}`).join('\n');
      systemPrompt += `\n\n## 子目标\n\n按顺序完成以下子目标：\n${goalList}\n\n完成每个子目标后，在思考中标注"[子目标完成: N]"（N为序号）。`;
    }
    this.conversation.init(systemPrompt, this.initialMessages, task);

    let finalResult: AgentRunResult;
    try {
      finalResult = await this.loop();
    } catch (err: any) {
      finalResult = { success: false, error: err.message, iterations: this.state.iteration };
    }

    // Attach token usage
    finalResult.tokenUsage = this.tokenTracker.getUsage();

    this.emitEvent({
      type: 'done',
      success: finalResult.success,
      result: finalResult.result,
      error: finalResult.error,
      iterations: finalResult.iterations,
      tokenUsage: finalResult.tokenUsage,
    });

    await this.cleanup();
    return finalResult;
  }

  private async loop(): Promise<AgentRunResult> {
    while (this.state.iteration < this.maxIterations && !this.state.done) {
      this.state.iteration++;
      console.log(`\n[Agent] === 第 ${this.state.iteration} 步 ===`);

      // 接近步数上限时注入提醒（仅一次，且 maxIterations > 3 时才有意义）
      const remainingSteps = this.maxIterations - this.state.iteration;
      if (!this.stepWarningInjected && remainingSteps <= 2 && remainingSteps > 0 && this.maxIterations > 3) {
        this.stepWarningInjected = true;
        this.conversation.push({
          role: 'user',
          content: `[系统提示] ⚠️ 你还剩 ${remainingSteps} 步就达到上限，请立即用 done 工具报告已获取的所有信息，不要再做额外操作。`,
        });
        console.log(`[Agent] 注入步数提醒，剩余 ${remainingSteps} 步`);
      }

      let response;
      try {
        response = await this.openai.chat.completions.create({
          model: this.model,
          messages: this.conversation.getMessages(),
          tools: this.tools,
          tool_choice: 'auto',
        });
        this.tokenTracker.recordLLMCall(response.usage as any);
      } catch (err: any) {
        this.state.consecutiveErrors++;
        console.log(`[Agent] LLM API 错误 (${this.state.consecutiveErrors}/${config.maxConsecutiveErrors}): ${err.message}`);
        this.emitEvent({ type: 'error', message: err.message, iteration: this.state.iteration });
        const recovery = determineRecovery({
          errorMessage: err.message,
          toolName: '_llm_api',
          consecutiveErrors: this.state.consecutiveErrors,
        });
        if (recovery.type === 'abort' || this.state.consecutiveErrors >= config.maxConsecutiveErrors) {
          return { success: false, error: `LLM API 连续失败: ${err.message}`, iterations: this.state.iteration };
        }
        const delay = recovery.type === 'retry' ? recovery.delayMs : 2000;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      const message = response.choices[0]?.message;
      if (!message) {
        return { success: false, error: 'LLM 返回空响应', iterations: this.state.iteration };
      }

      if (message.content) {
        console.log(`[Agent] 思考: ${message.content}`);
        this.emitEvent({ type: 'thinking', content: message.content, iteration: this.state.iteration });

        // Detect subgoal completion markers in thinking
        const goalMatch = message.content.match(/\[子目标完成:\s*(\d+)\]/);
        if (goalMatch) {
          const idx = parseInt(goalMatch[1], 10) - 1;
          if (idx >= 0 && idx < this.subGoals.length && !this.subGoals[idx].completed) {
            this.subGoals[idx].completed = true;
            this.emitEvent({ type: 'subgoal_completed', subGoal: this.subGoals[idx].description, iteration: this.state.iteration });
          }
        }
      }

      this.conversation.push(message);

      if (!message.tool_calls || message.tool_calls.length === 0) {
        console.log('[Agent] LLM 未调用工具，任务结束');
        return {
          success: true,
          result: message.content || '任务完成',
          iterations: this.state.iteration,
        };
      }

      const doneResult = await this.executeToolCalls(message.tool_calls as any);
      if (doneResult) {
        return doneResult;
      }
    }

    if (!this.state.done) {
      return { success: false, error: `达到最大迭代次数 ${this.maxIterations}`, iterations: this.state.iteration };
    }
    return { success: true, iterations: this.state.iteration };
  }

  private async executeToolCalls(toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>): Promise<AgentRunResult | null> {
    const deferredHints: string[] = [];
    for (const toolCall of toolCalls) {
      const name = toolCall.function.name;
      let args: Record<string, any>;
      try {
        args = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        console.log(`[Agent] 工具参数解析失败: ${toolCall.function.arguments}`);
        this.conversation.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({ error: '工具参数 JSON 解析失败' }),
        });
        this.state.consecutiveErrors++;
        continue;
      }

      console.log(`[Agent] 调用工具: ${name}(${JSON.stringify(args)})`);
      this.emitEvent({ type: 'tool_call', name, args, iteration: this.state.iteration });

      if (name === 'done') {
        const result = args.result || '任务完成';
        console.log(`[Agent] 任务完成: ${result}`);
        this.state.done = true;
        return { success: true, result, iterations: this.state.iteration };
      }

      // ask_human: 暂停等待用户输入
      if (name === 'ask_human') {
        const requestId = randomUUID();
        const question: string = args.question || '';
        const fields: InputField[] = args.fields || [];
        const passwordFieldNames = new Set(fields.filter(f => f.type === 'password').map(f => f.name));
        console.log(`[Agent] 请求用户输入: ${question}`);
        this.pendingInputRequestId = requestId;
        this.emitEvent({ type: 'input_required', requestId, question, fields });

        let userResponse: Record<string, string>;
        try {
          userResponse = await new Promise<Record<string, string>>((resolve, reject) => {
            this.pendingInputResolve = resolve;
            const timer = setTimeout(() => {
              if (this.pendingInputResolve) {
                this.pendingInputResolve = null;
                this.pendingInputRequestId = null;
                reject(new Error('用户未响应'));
              }
            }, 5 * 60 * 1000);
            // Store timer ref so resolveInput can clear it
            this._askHumanTimer = timer;
          });
        } catch {
          userResponse = { error: '用户未在规定时间内响应' };
        }

        // Build redacted version for SSE event (mask password values)
        const redacted: Record<string, string> = {};
        for (const [k, v] of Object.entries(userResponse)) {
          redacted[k] = passwordFieldNames.has(k) ? '***' : v;
        }
        const redactedText = JSON.stringify(redacted);
        const responseText = JSON.stringify(userResponse);

        console.log(`[Agent] 用户输入已收到`);
        this.emitEvent({ type: 'tool_result', name: 'ask_human', success: true, summary: redactedText, iteration: this.state.iteration });
        this.conversation.push({ role: 'tool', tool_call_id: toolCall.id, content: responseText });
        continue;
      }

      // 强制覆盖 sessionId，防止 LLM 猜测错误的值
      const mcpArgs = { ...args };
      if (this.state.sessionId) {
        mcpArgs.sessionId = this.state.sessionId;
      }

      let rawText: string;
      let success = true;
      try {
        const mcpResult = await this.mcpClient.callTool({ name, arguments: mcpArgs });
        const textPart = (mcpResult.content as any[])?.find((c) => c?.type === 'text' && typeof c.text === 'string');
        rawText = textPart?.text || '{}';
        if (mcpResult.isError) success = false;
      } catch (err: any) {
        rawText = JSON.stringify({ error: err.message });
        success = false;
      }

      // Record in tracker
      this.toolTracker.record({
        toolName: name,
        args,
        success,
        timestamp: Date.now(),
        errorCode: success ? undefined : extractErrorCode(rawText),
      });

      if (!success) {
        this.state.consecutiveErrors++;
        console.log(`[Agent] 错误 (${this.state.consecutiveErrors}/${config.maxConsecutiveErrors}): ${rawText}`);
        const errorCode = extractErrorCode(rawText);
        const recovery = determineRecovery({
          errorCode,
          errorMessage: rawText,
          toolName: name,
          consecutiveErrors: this.state.consecutiveErrors,
        });

        if (recovery.type === 'abort') {
          this.conversation.push({ role: 'tool', tool_call_id: toolCall.id, content: rawText });
          return { success: false, error: recovery.reason, iterations: this.state.iteration };
        }

        if (this.state.consecutiveErrors >= config.maxConsecutiveErrors) {
          this.conversation.push({ role: 'tool', tool_call_id: toolCall.id, content: rawText });
          return {
            success: false,
            error: `连续 ${config.maxConsecutiveErrors} 次错误，任务中止`,
            iterations: this.state.iteration,
          };
        }

        if (recovery.type === 'inject_hint') {
          this.conversation.push({ role: 'tool', tool_call_id: toolCall.id, content: rawText });
          deferredHints.push(`[系统提示] ⚠️ ${recovery.message}`);
          continue;
        }
      } else {
        this.state.consecutiveErrors = 0;
      }

      // Loop/pattern detection — defer hint to avoid interleaving with tool results
      const loopDetection = this.toolTracker.detectAny();
      if (loopDetection) {
        console.log(`[Agent] 检测到${loopDetection.type}，注入提醒`);
        deferredHints.push(`[系统提示] ⚠️ ${loopDetection.message}`);
      }

      // SSE event sends full content; LLM message gets budget-aware version
      let formatted = formatToolResult(rawText, name);

      // Apply page state diff for get_page_info on same-page refreshes
      if (name === 'get_page_info' && success) {
        try {
          const pageData = JSON.parse(rawText);
          const elements = Array.isArray(pageData.elements) ? pageData.elements : [];
          const url = pageData.page?.url || '';
          const diff = this.pageStateCache.update(this.state.sessionId, elements, url);
          if (!diff.isNewPage && (diff.added.length + diff.removed.length + diff.changed.length) > 0) {
            const diffLines = [
              `## Page State Diff (unchanged: ${diff.unchangedCount})`,
              '',
            ];
            if (diff.added.length > 0) {
              diffLines.push(`### Added (${diff.added.length})`);
              for (const el of diff.added.slice(0, 20)) {
                diffLines.push(`- \`${el.id}\` ${el.type || ''} ${el.label || ''}`);
              }
            }
            if (diff.removed.length > 0) {
              diffLines.push(`### Removed (${diff.removed.length})`);
              for (const id of diff.removed.slice(0, 20)) {
                diffLines.push(`- \`${id}\``);
              }
            }
            if (diff.changed.length > 0) {
              diffLines.push(`### Changed (${diff.changed.length})`);
              for (const el of diff.changed.slice(0, 20)) {
                diffLines.push(`- \`${el.id}\` ${el.type || ''} ${el.label || ''}`);
              }
            }
            formatted = diffLines.join('\n');
          }
        } catch {
          // Parse failed — use the standard formatted output
        }
      }
      console.log(`[Agent] 结果: ${formatted.slice(0, 200)}${formatted.length > 200 ? '...' : ''}`);
      this.emitEvent({
        type: 'tool_result',
        name,
        success,
        summary: rawText,
        iteration: this.state.iteration,
      });

      this.conversation.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: formatted,
      });

      // Emit progress after each tool call
      const progress = this.progressEstimator.record(name);
      this.emitEvent({ type: 'progress', progress, iteration: this.state.iteration });
    }

    // Push all deferred hints after tool results to avoid breaking tool message contiguity
    for (const hint of deferredHints) {
      this.conversation.push({ role: 'user', content: hint });
    }

    return null;
  }

  async cleanup(): Promise<void> {
    if (this._askHumanTimer) {
      clearTimeout(this._askHumanTimer);
      this._askHumanTimer = null;
    }
    if (this.state.sessionId) {
      console.log('[Agent] 清理浏览器会话...');
      try {
        await this.mcpClient.callTool({
          name: 'close_session',
          arguments: { sessionId: this.state.sessionId },
        });
      } catch (err: any) {
        console.log(`[Agent] 清理警告: ${err.message}`);
      }
    }
  }
}
