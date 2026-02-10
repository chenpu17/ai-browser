import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { config } from './config.js';
import { SYSTEM_PROMPT } from './prompt.js';
import type { AgentState, AgentRunResult, AgentEvent, InputField } from './types.js';

const MAX_CONTENT_LENGTH = 4000;

function truncate(text: string, max = MAX_CONTENT_LENGTH): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n...(已截断，共${text.length}字符)`;
}

function formatForLLM(rawText: string, toolName: string): string {
  try {
    const data = JSON.parse(rawText);
    if (toolName === 'get_page_info' && data?.elements) {
      const summary: any = {
        page: data.page,
        elementCount: data.elements.length,
        elements: data.elements.slice(0, 30).map((e: any) => ({
          id: e.id,
          type: e.type,
          label: e.label,
        })),
        intents: data.intents,
      };
      if (data.stability) summary.stability = data.stability;
      if (data.pendingDialog) summary.pendingDialog = data.pendingDialog;
      if (data.elements.length > 30) {
        summary.note = `显示前30个元素，共${data.elements.length}个`;
      }
      return truncate(JSON.stringify(summary, null, 2));
    }
    if (toolName === 'get_page_content') {
      let md = `# ${data.title || ''}\n\n`;
      const sections = Array.isArray(data.sections) ? data.sections : [];
      for (const s of sections) {
        const stars = s.attention >= 0.7 ? '★★★'
                   : s.attention >= 0.4 ? '★★'
                   : '★';
        md += `[${stars}] ${s.text}\n\n`;
      }
      if (sections.length === 0) md += '(未提取到内容)\n';
      return truncate(md);
    }
    return truncate(JSON.stringify(data));
  } catch {
    return truncate(rawText);
  }
}

export class BrowsingAgent extends EventEmitter {
  private openai: OpenAI;
  private mcpClient: Client;
  private state: AgentState;
  private messages: ChatCompletionMessageParam[];
  private model: string;
  private maxIterations: number;
  private initialMessages: ChatCompletionMessageParam[];
  private tools: ChatCompletionTool[] = [];
  private recentToolCalls: string[] = []; // 循环检测：记录最近工具调用签名
  private stepWarningInjected = false;
  private pendingInputResolve: ((response: Record<string, string>) => void) | null = null;
  private pendingInputRequestId: string | null = null;

  constructor(options: {
    apiKey?: string;
    baseURL?: string;
    model?: string;
    mcpClient: Client;
    maxIterations?: number;
    initialMessages?: ChatCompletionMessageParam[];
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
    this.state = {
      sessionId: '',
      iteration: 0,
      consecutiveErrors: 0,
      done: false,
    };
    this.messages = [];
  }

  get sessionId(): string {
    return this.state.sessionId;
  }

  resolveInput(requestId: string, response: Record<string, string>): boolean {
    if (this.pendingInputRequestId !== requestId || !this.pendingInputResolve) {
      return false;
    }
    // Clear the timeout timer to prevent resource leak
    if ((this as any)._askHumanTimer) {
      clearTimeout((this as any)._askHumanTimer);
      (this as any)._askHumanTimer = null;
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
      const text = (sessionResult.content as any)[0]?.text;
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
    this.messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...this.initialMessages,
      { role: 'user', content: task },
    ];

    let finalResult: AgentRunResult;
    try {
      finalResult = await this.loop();
    } catch (err: any) {
      finalResult = { success: false, error: err.message, iterations: this.state.iteration };
    }

    this.emitEvent({
      type: 'done',
      success: finalResult.success,
      result: finalResult.result,
      error: finalResult.error,
      iterations: finalResult.iterations,
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
        this.messages.push({
          role: 'system',
          content: `⚠️ 你还剩 ${remainingSteps} 步就达到上限，请立即用 done 工具报告已获取的所有信息，不要再做额外操作。`,
        });
        console.log(`[Agent] 注入步数提醒，剩余 ${remainingSteps} 步`);
      }

      let response;
      try {
        response = await this.openai.chat.completions.create({
          model: this.model,
          messages: this.messages,
          tools: this.tools,
          tool_choice: 'auto',
        });
      } catch (err: any) {
        this.state.consecutiveErrors++;
        console.log(`[Agent] LLM API 错误 (${this.state.consecutiveErrors}/${config.maxConsecutiveErrors}): ${err.message}`);
        this.emitEvent({ type: 'error', message: err.message, iteration: this.state.iteration });
        if (this.state.consecutiveErrors >= config.maxConsecutiveErrors) {
          return { success: false, error: `LLM API 连续失败: ${err.message}`, iterations: this.state.iteration };
        }
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      const message = response.choices[0]?.message;
      if (!message) {
        return { success: false, error: 'LLM 返回空响应', iterations: this.state.iteration };
      }

      if (message.content) {
        console.log(`[Agent] 思考: ${message.content}`);
        this.emitEvent({ type: 'thinking', content: message.content, iteration: this.state.iteration });
      }

      this.messages.push(message);

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
    for (const toolCall of toolCalls) {
      const name = toolCall.function.name;
      let args: Record<string, any>;
      try {
        args = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        console.log(`[Agent] 工具参数解析失败: ${toolCall.function.arguments}`);
        this.messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({ error: '工具参数 JSON 解析失败' }),
        });
        this.state.consecutiveErrors++;
        continue;
      }

      console.log(`[Agent] 调用工具: ${name}(${JSON.stringify(args)})`);
      this.emitEvent({ type: 'tool_call', name, args, iteration: this.state.iteration });

      // 循环检测：记录工具调用签名
      const callSig = `${name}:${JSON.stringify(args)}`;
      this.recentToolCalls.push(callSig);
      if (this.recentToolCalls.length > 3) {
        this.recentToolCalls.shift();
      }
      if (
        this.recentToolCalls.length === 3 &&
        this.recentToolCalls[0] === this.recentToolCalls[1] &&
        this.recentToolCalls[1] === this.recentToolCalls[2]
      ) {
        console.log('[Agent] 检测到循环调用，注入提醒');
        this.messages.push({
          role: 'system',
          content: '⚠️ 你已连续3次调用相同工具且参数相同，这不会产生新结果。请换一种方式操作，或用 done 工具报告当前已获取的信息。',
        });
        this.recentToolCalls = [];
      }

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
            (this as any)._askHumanTimer = timer;
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
        this.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: responseText });
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

      if (!success) {
        this.state.consecutiveErrors++;
        console.log(`[Agent] 错误 (${this.state.consecutiveErrors}/${config.maxConsecutiveErrors}): ${rawText}`);
        if (this.state.consecutiveErrors >= config.maxConsecutiveErrors) {
          this.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: rawText });
          return {
            success: false,
            error: `连续 ${config.maxConsecutiveErrors} 次错误，任务中止`,
            iterations: this.state.iteration,
          };
        }
      } else {
        this.state.consecutiveErrors = 0;
      }

      // SSE event sends full content; LLM message gets truncated version
      const formatted = formatForLLM(rawText, name);
      console.log(`[Agent] 结果: ${formatted.slice(0, 200)}${formatted.length > 200 ? '...' : ''}`);
      this.emitEvent({
        type: 'tool_result',
        name,
        success,
        summary: rawText,
        iteration: this.state.iteration,
      });

      this.messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: formatted,
      });
    }
    return null;
  }

  async cleanup(): Promise<void> {
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
