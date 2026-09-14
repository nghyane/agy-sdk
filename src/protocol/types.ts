export interface Usage {
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
}

export type RunStatus = "SUCCESS" | "ERROR" | "CANCELED" | "INTERRUPTED" | "INVALID" | "WAITING" | "RUNNING";

export interface RunResult {
  conversation_id: string;
  status: RunStatus;
  response: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  structured_output?: unknown;
  json_schema?: unknown;
  usage?: Usage;
}

export interface ToolInfo {
  name: string;
  parameters?: Record<string, unknown>;
  output?: string;
  error?: { type?: string; message?: string };
}

export interface SubagentInfo {
  subagents?: Array<{ type_name?: string; role?: string; conversation_id?: string; log_uri?: string }>;
}

export interface StepUpdate {
  conversation_id: string;
  step_index: number;
  state: "ACTIVE" | "DONE";
  step_type: string;
  text_delta?: string;
  duration_seconds?: number;
  usage?: Usage;
  tool_name?: string;
  tool_info?: ToolInfo;
  subagent_info?: SubagentInfo;
}

export interface InitInfo {
  cwd: string;
  tools: string[];
  permission_mode?: string;
  model?: string;
  agent?: string;
  json_schema?: unknown;
}

export type AgyEvent =
  | { event: "init"; conversation_id: string; init: InitInfo }
  | { event: "step_update"; step_update: StepUpdate }
  | { event: "result"; result: RunResult };
