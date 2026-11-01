import type { AgentConfig } from "../types.js";
import { truncate } from "../util/text.js";
import type { ChatMessage, LLM, LLMRequest, LLMResult, LLMUsage, ToolCall } from "./types.js";

interface RawToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string | Record<string, unknown> };
  [key: string]: unknown;
}

interface OpenAIChoice {
  message?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }> | null;
    tool_calls?: RawToolCall[];
  };
  finish_reason?: string;
}

interface OpenAIResponse {
  choices?: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string; type?: string };
}

interface ProviderTarget {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export class OpenAICompatibleLLM implements LLM {
  readonly label: string;
  private readonly primary: ProviderTarget;
  private readonly fallback?: ProviderTarget;

  constructor(private readonly config: AgentConfig) {
    this.label = `${config.provider.model} @ ${config.provider.baseUrl}`;
    this.primary = {
      baseUrl: config.provider.baseUrl,
      model: config.provider.model,
      apiKey: config.provider.apiKey ?? "",
    };
    if (config.provider.fallbackBaseUrl && config.provider.fallbackModel && config.provider.fallbackApiKey) {
      this.fallback = {
        baseUrl: config.provider.fallbackBaseUrl,
        model: config.provider.fallbackModel,
        apiKey: config.provider.fallbackApiKey,
      };
    }
  }

  async chat(request: LLMRequest): Promise<LLMResult> {
    const targets = this.fallback ? [this.primary, this.fallback] : [this.primary];
    let lastError: Error | undefined;
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
      const target = targets[targetIndex];
      if (!target) continue;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          return await this.once(request, target);
        } catch (error) {
          lastError = error as Error;
          const hasFallback = targetIndex < targets.length - 1;
          if (hasFallback && shouldFailOver(error)) break;
          if (!isRetryable(error) || attempt === 3) break;
          await sleep(retryDelay(error, attempt));
        }
      }
    }
    throw lastError ?? new Error("Gọi LLM thất bại không rõ nguyên nhân.");
  }

  private async once(request: LLMRequest, target: ProviderTarget): Promise<LLMResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.provider.timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, controller.signal])
      : controller.signal;

    const body = {
      model: target.model,
      messages: request.messages,
      temperature: request.temperature ?? this.config.provider.temperature,
      max_tokens: request.maxTokens ?? this.config.provider.maxTokens,
      // Không gửi parallel_tool_calls: một số gateway (Groq/Gemini/OpenCode)
      // không hỗ trợ hoặc xử lý khác nhau. Orchestrator vẫn chạy tool tuần tự.
      ...(request.tools.length > 0 ? { tools: request.tools, tool_choice: "auto" } : {}),
    };

    try {
      const endpoint = `${target.baseUrl.replace(/\/+$/, "")}/chat/completions`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${target.apiKey}`,
          "User-Agent": "sales-management-orchestrator/1.0",
        },
        body: JSON.stringify(body),
        signal,
      });

      const text = await response.text();
      if (!response.ok) {
        const snippet = truncate(text, 800);
        const error = new Error(`LLM HTTP ${response.status}: ${snippet}`) as Error & {
          status?: number;
          retryAfter?: number;
        };
        error.status = response.status;
        const retryAfter = Number(response.headers.get("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfter = retryAfter;
        throw error;
      }

      let data: OpenAIResponse;
      try {
        data = JSON.parse(text) as OpenAIResponse;
      } catch {
        throw new Error(`LLM trả về không phải JSON: ${truncate(text, 400)}`);
      }
      if (data.error?.message) throw new Error(`LLM báo lỗi: ${data.error.message}`);
      const choice = data.choices?.[0];
      if (!choice?.message) throw new Error("LLM không trả về message.");

      const content = normalizeContent(choice.message.content);
      const toolCalls = normalizeToolCalls(choice.message.tool_calls);
      const usage: LLMUsage = {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
      };
      return {
        message: {
          role: "assistant",
          content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        usage,
        ...(choice.finish_reason ? { finishReason: choice.finish_reason } : {}),
      };
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new Error(
          `LLM timeout sau ${Math.round(this.config.provider.timeoutMs / 1000)}s (${this.label}).`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeContent(
  content: string | Array<{ type?: string; text?: string }> | null | undefined,
): string | null {
  if (content === null || content === undefined) return null;
  if (typeof content === "string") return content;
  const joined = content
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n");
  return joined.length > 0 ? joined : null;
}

function normalizeToolCalls(calls: RawToolCall[] | undefined): ToolCall[] {
  if (!calls) return [];
  return calls.map((call, index) => {
    const rawArguments = call.function?.arguments;
    return {
      ...call,
      id: call.id ?? `call_${index}_${Date.now()}`,
      type: "function" as const,
      function: {
        name: call.function?.name ?? "unknown",
        arguments:
          typeof rawArguments === "string"
            ? rawArguments
            : JSON.stringify(rawArguments ?? {}),
      },
    };
  });
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as Error & { status?: number }).status;
  if (status !== undefined) return status === 408 || status === 409 || status === 429 || status >= 500;
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(error.message);
}

function shouldFailOver(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as Error & { status?: number }).status;
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504 ||
    /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|LLM timeout/i.test(error.message);
}

function retryDelay(error: unknown, attempt: number): number {
  const retryAfter = (error as Error & { retryAfter?: number } | undefined)?.retryAfter;
  if (retryAfter && retryAfter > 0) return Math.min(retryAfter * 1000, 30_000);
  return Math.min(1_000 * 2 ** (attempt - 1), 10_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Kiểm tra kết nối/model mà không làm tốn nhiều token. */
export async function pingLLM(llm: LLM): Promise<string> {
  const result = await llm.chat({
    messages: [
      { role: "system", content: "Trả lời ngắn gọn." },
      { role: "user", content: "ping" },
    ],
    tools: [],
    maxTokens: 8,
  });
  const reply = result.message.content?.trim() || "(rỗng)";
  return `OK — ${llm.label} — phản hồi: ${truncate(reply, 80)}`;
}

export function messagesForLog(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    content: message.content ? truncate(message.content, 2000) : message.content,
  }));
}
