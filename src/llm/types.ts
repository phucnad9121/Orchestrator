export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
  /** Provider-specific fields (e.g. Gemini extra_content.google.thought_signature). */
  [key: string]: unknown;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface LLMResult {
  message: ChatMessage & { role: "assistant" };
  usage: LLMUsage;
  finishReason?: string;
}

export interface LLMRequest {
  messages: ChatMessage[];
  tools: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LLM {
  readonly label: string;
  chat(request: LLMRequest): Promise<LLMResult>;
}
