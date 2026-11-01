import { describe, expect, it, vi } from "vitest";
import { dispatchTelegramCommand, type TelegramCommandContext } from "../src/core/telegram-bot.js";
import type { TelegramBotUpdate } from "../src/core/telegram.js";

function makeContext(overrides: Partial<TelegramCommandContext> = {}) {
  const calls: string[] = [];
  const context: TelegramCommandContext = {
    authorizedChatId: "12345",
    sendMessage: vi.fn(async (text: string) => { calls.push(`send:${text}`); }),
    getStatus: vi.fn((runId?: string) => `status:${runId}`),
    getApprovals: vi.fn((runId?: string) => `approvals:${runId}`),
    startRun: vi.fn(async (request: string) => { calls.push(`run:${request}`); }),
    resumeRun: vi.fn(async (runId: string) => { calls.push(`resume:${runId}`); }),
    resolveApproval: vi.fn(async (runId: string, id: string, decision: "approve" | "reject", reason?: string) => {
      calls.push(`${decision}:${runId}:${id}:${reason ?? ""}`);
    }),
    ...overrides,
  };
  return { context, calls };
}

function update(text: string, options: { chatId?: string; type?: string; isBot?: boolean } = {}): TelegramBotUpdate {
  return {
    update_id: 1,
    message: {
      text,
      chat: { id: options.chatId ?? "12345", type: options.type ?? "private" },
      from: { is_bot: options.isBot ?? false },
    },
  };
}

describe("Telegram control commands", () => {
  it("ignores messages outside the configured private chat", async () => {
    const { context } = makeContext();
    await dispatchTelegramCommand(update("/run do something", { chatId: "99999" }), context);
    await dispatchTelegramCommand(update("/run do something", { type: "group" }), context);
    await dispatchTelegramCommand(update("/run do something", { isBot: true }), context);
    expect(context.startRun).not.toHaveBeenCalled();
    expect(context.sendMessage).not.toHaveBeenCalled();
  });

  it("starts work from /run and supports bot command mentions", async () => {
    const { context } = makeContext();
    await dispatchTelegramCommand(update("/run@my_agent_bot Add a small version label"), context);
    expect(context.startRun).toHaveBeenCalledWith("Add a small version label");
  });

  it("routes status and approval decisions, then resumes after approval", async () => {
    const { context, calls } = makeContext();
    await dispatchTelegramCommand(update("/status"), context);
    await dispatchTelegramCommand(update("/approvals run-20261101-abcd"), context);
    await dispatchTelegramCommand(update("/approve run-20261101-abcd all"), context);
    await dispatchTelegramCommand(update("/reject run-20261101-abcd apr-123 keep current behavior"), context);

    expect(context.getStatus).toHaveBeenCalledWith("latest");
    expect(context.getApprovals).toHaveBeenCalledWith("run-20261101-abcd");
    expect(calls).toContain("approve:run-20261101-abcd:all:");
    expect(calls).toContain("resume:run-20261101-abcd");
    expect(calls).toContain("reject:run-20261101-abcd:apr-123:keep current behavior");
  });

  it("returns usage errors to the authorized chat", async () => {
    const { context } = makeContext();
    await dispatchTelegramCommand(update("/run"), context);
    expect(context.sendMessage).toHaveBeenCalledWith(expect.stringContaining("Cú pháp: /run"));
  });
});
