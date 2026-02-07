export interface AgentState {
  sessionId: string;
  iteration: number;
  consecutiveErrors: number;
  done: boolean;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface AgentRunResult {
  success: boolean;
  result?: string;
  error?: string;
  iterations: number;
}

export type AgentEvent =
  | { type: 'session_created'; sessionId: string }
  | { type: 'thinking'; content: string; iteration: number }
  | { type: 'tool_call'; name: string; args: Record<string, any>; iteration: number }
  | { type: 'tool_result'; name: string; success: boolean; summary: string; iteration: number }
  | { type: 'done'; success: boolean; result?: string; error?: string; iterations: number }
  | { type: 'error'; message: string; iteration: number };
