export interface InputField {
  name: string;
  label: string;
  type: 'text' | 'password';
}

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

export interface TokenUsageInfo {
  input: number;
  output: number;
  total: number;
}

export interface SubGoal {
  description: string;
  completed: boolean;
}

export interface ProgressInfo {
  phase: string;
  percent: number;
  stepsRemaining: number | null;
}

export interface AgentRunResult {
  success: boolean;
  result?: string;
  error?: string;
  iterations: number;
  tokenUsage?: TokenUsageInfo;
}

export type AgentEvent =
  | { type: 'session_created'; sessionId: string }
  | { type: 'thinking'; content: string; iteration: number }
  | { type: 'tool_call'; name: string; args: Record<string, any>; iteration: number }
  | { type: 'tool_result'; name: string; success: boolean; summary: string; iteration: number }
  | { type: 'done'; success: boolean; result?: string; error?: string; iterations: number; tokenUsage?: TokenUsageInfo }
  | { type: 'error'; message: string; iteration: number }
  | { type: 'progress'; progress: ProgressInfo; iteration: number }
  | { type: 'subgoal_completed'; subGoal: string; iteration: number }
  | { type: 'input_required'; requestId: string; question: string; fields: InputField[] };
