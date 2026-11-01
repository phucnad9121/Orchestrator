import type { AgentConfig } from "../types.js";
import { assertProviderReady } from "../config.js";
import { MockLLM } from "./mock.js";
import { OpenAICompatibleLLM } from "./openai.js";
import { OpenCodeLLM } from "./opencode.js";
import type { LLM } from "./types.js";

export function createLLM(config: AgentConfig): LLM {
  if (config.provider.type === "mock") return new MockLLM();
  assertProviderReady(config);
  if (config.provider.type === "opencode") return new OpenCodeLLM(config);
  return new OpenAICompatibleLLM(config);
}

export type { LLM, LLMRequest, LLMResult, ChatMessage, ToolSchema } from "./types.js";
export { pingLLM } from "./openai.js";
