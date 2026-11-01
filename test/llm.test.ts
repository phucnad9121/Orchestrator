import { afterEach, describe, expect, it, vi } from "vitest";
import { redactedConfig } from "../src/config.js";
import { OpenAICompatibleLLM } from "../src/llm/openai.js";
import { makeConfig } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI-compatible provider failover", () => {
  it("preserves provider-specific Gemini thought signatures across tool-call turns", async () => {
    const signature = "opaque-gemini-thought-signature";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_fs_list",
            type: "function",
            function: { name: "fs_list", arguments: "{}" },
            extra_content: { google: { thought_signature: signature } },
          }],
        } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Done" } }],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const config = makeConfig({
      provider: {
        type: "openai",
        baseUrl: "https://gemini.example/v1beta/openai",
        model: "gemini-3.8-flash",
        apiKey: "test-key",
      },
    });
    const llm = new OpenAICompatibleLLM(config);
    const tools = [{ type: "function" as const, function: { name: "fs_list", description: "List files", parameters: { type: "object" } } }];
    const userMessage = { role: "user" as const, content: "List files" };
    const first = await llm.chat({ messages: [userMessage], tools });
    expect(first.message.tool_calls?.[0]?.extra_content).toEqual({ google: { thought_signature: signature } });

    await llm.chat({
      messages: [
        userMessage,
        first.message,
        { role: "tool", tool_call_id: "call_fs_list", content: "[]" },
      ],
      tools,
    });
    const secondRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      messages: Array<{ tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }> }>;
    };
    expect(secondRequest.messages[1]?.tool_calls?.[0]?.extra_content?.google?.thought_signature).toBe(signature);
  });

  it("switches to the configured backup after a primary 503", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "backup ok" } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const config = makeConfig({
      provider: {
        type: "openai",
        baseUrl: "https://primary.example/v1",
        model: "primary-model",
        apiKey: "primary-secret",
        fallbackBaseUrl: "https://backup.example/v1",
        fallbackModel: "backup-model",
        fallbackApiKey: "backup-secret",
      },
    });
    const llm = new OpenAICompatibleLLM(config);
    const result = await llm.chat({ messages: [{ role: "user", content: "ping" }], tools: [] });

    expect(result.message.content).toBe("backup ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://primary.example/v1/chat/completions");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://backup.example/v1/chat/completions");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).model).toBe("primary-model");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).model).toBe("backup-model");
    expect((fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>).Authorization).toBe("Bearer backup-secret");
  });

  it("redacts both primary and fallback keys from run config snapshots", () => {
    const config = makeConfig({
      provider: { apiKey: "primary-secret", fallbackApiKey: "backup-secret" },
    });
    const redacted = redactedConfig(config);

    expect(redacted.provider.apiKey).toBe("[REDACTED]");
    expect(redacted.provider.fallbackApiKey).toBe("[REDACTED]");
  });
});
