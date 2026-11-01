import { randomUUID } from "node:crypto";
import type { AgentConfig } from "../types.js";
import { truncate } from "../util/text.js";
import type { ChatMessage, LLM, LLMRequest, LLMResult, ToolCall } from "./types.js";

interface GenerateResponse {
  text?: string;
  data?: { text?: string };
  error?: { message?: string };
}

interface StructuredToolCall {
  id?: string;
  type?: string;
  name?: string;
  arguments?: string | Record<string, unknown>;
  function?: { name?: string; arguments?: string | Record<string, unknown> };
}

interface StructuredReply {
  content?: string | null;
  tool_calls?: StructuredToolCall[];
}

/**
 * OpenCode's local server uses the user's existing OAuth session (Copilot,
 * ChatGPT, or another configured provider), so no provider API key is needed.
 * Its one-shot generation route returns text; tool calls are represented as
 * constrained JSON and dispatched by the orchestrator's existing tool runtime.
 */
export class OpenCodeLLM implements LLM {
  readonly label: string;
  private readonly serverUrl: string;
  private readonly model: { providerID: string; id: string };

  constructor(private readonly config: AgentConfig) {
    this.serverUrl = (config.provider.opencodeServerUrl || "http://127.0.0.1:4096").replace(/\/+$/, "");
    this.model = parseModelRef(config.provider.model);
    this.label = `${config.provider.model} @ OpenCode ${this.serverUrl}`;
  }

  async chat(request: LLMRequest): Promise<LLMResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.provider.timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, controller.signal])
      : controller.signal;

    const prompt = makePrompt(request.messages, request.tools);
    const body = JSON.stringify({ prompt, model: this.model });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "sales-management-orchestrator/1.0",
    };
    if (this.config.provider.opencodePassword) {
      const username = this.config.provider.opencodeUsername || "opencode";
      headers.Authorization = `Basic ${Buffer.from(`${username}:${this.config.provider.opencodePassword}`).toString("base64")}`;
    }

    try {
      const response = await this.generate(body, headers, signal);
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`OpenCode HTTP ${response.status}: ${truncate(text, 700)}`) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }

      let data: GenerateResponse;
      try {
        data = JSON.parse(text) as GenerateResponse;
      } catch {
        throw new Error(`OpenCode response was not valid JSON: ${truncate(text, 300)}`);
      }
      if (data.error?.message) throw new Error(`OpenCode báo lỗi: ${data.error.message}`);
      const generatedText = data.data?.text ?? data.text;
      if (typeof generatedText !== "string") throw new Error("OpenCode không trả trường data.text.");

      const message = request.tools.length > 0
        ? parseStructuredReply(generatedText)
        : { role: "assistant" as const, content: generatedText };
      return {
        message,
        usage: { promptTokens: 0, completionTokens: 0 },
        finishReason: message.tool_calls?.length ? "tool_calls" : "stop",
      };
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new Error(`OpenCode timeout sau ${Math.round(this.config.provider.timeoutMs / 1000)}s (${this.label}).`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async generate(body: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
    // Newer OpenCode versions expose /text; 2.1.x keeps /generate as an alias.
    // Retry the compatible route only when the newer route is not found.
    const routes = ["/api/experimental/generate/text", "/api/experimental/generate"];
    let response: Response | undefined;
    for (const route of routes) {
      response = await fetch(`${this.serverUrl}${route}`, {
        method: "POST",
        headers,
        body,
        signal,
      });
      if (response.status !== 404) return response;
    }
    return response!;
  }
}

function parseModelRef(model: string): { providerID: string; id: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error('OpenCode model cần định dạng "provider/model"; xem danh sách bằng lệnh `opencode models`.');
  }
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
}

function makePrompt(messages: ChatMessage[], tools: LLMRequest["tools"]): string {
  const transcript = messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.name ? { name: message.name } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
  }));
  const toolInstructions = tools.length > 0
    ? [
        "You are producing one assistant turn for a tool-using orchestrator.",
        "Return exactly one JSON object and no Markdown or surrounding prose, with this shape:",
        '{"content": string or null, "tool_calls": [{"id": string, "name": string, "arguments": object}]}',
        "Choose zero or more tools only from the supplied tool list. Arguments must be a JSON object, not JSON encoded inside a string.",
        "If the previous assistant turn was empty, recover by returning either a tool call or a non-empty final answer.",
        "Use an empty tool_calls array when replying to the user without a tool.",
        `TOOLS:\n${JSON.stringify(tools)}`,
      ].join("\n")
    : "Continue the conversation. Return only the assistant response text, without Markdown fences unless the user requested code.";
  return `${toolInstructions}\n\nCONVERSATION (JSON):\n${JSON.stringify(transcript)}`;
}

function parseStructuredReply(text: string): ChatMessage & { role: "assistant" } {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: StructuredReply;
  try {
    parsed = JSON.parse(cleaned) as StructuredReply;
  } catch {
    throw new Error(`OpenCode tool-response JSON không hợp lệ: ${truncate(text, 500)}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("OpenCode tool response không phải object JSON.");
  }

  const calls: ToolCall[] = (parsed.tool_calls ?? []).map((call, index) => {
    const name = call.function?.name ?? call.name;
    const args = call.function?.arguments ?? call.arguments;
    if (!name) throw new Error(`OpenCode tool call thứ ${index + 1} thiếu function.name.`);
    return {
      id: call.id || `opencode_${randomUUID()}`,
      type: "function",
      function: {
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
      },
    };
  });
  return {
    role: "assistant",
    content: typeof parsed.content === "string" ? parsed.content : null,
    ...(calls.length > 0 ? { tool_calls: calls } : {}),
  };
}
