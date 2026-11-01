import { describe, expect, it, vi } from "vitest";
import { createRunState, loadRun, prepareRunDir } from "../src/core/state.js";
import {
  createTelegramControlApi,
  getTelegramConfigStatus,
  notifyTelegramRunStatus,
  renderTelegramRunMessage,
} from "../src/core/telegram.js";
import { tempWorkspace } from "./helpers.js";

const telegramEnv = {
  TELEGRAM_NOTIFY: "true",
  TELEGRAM_BOT_TOKEN: "123456:bot-token-with-enough-characters-123456",
  TELEGRAM_CHAT_ID: "987654321",
};

function makeRun(workspace: string, status: "completed" | "failed" | "awaiting_approval" = "completed") {
  const state = createRunState({
    request: "Sửa một phần nhỏ",
    workspace,
    mode: "live",
    git: { isRepo: false, dirtyAtStart: false, status: "" },
    maxFixCycles: 1,
  });
  state.status = status;
  state.tasks = [{
    id: "verify-1",
    title: "Kiểm tra",
    role: "testing",
    description: "Chạy suite",
    acceptance: [],
    dependsOn: [],
    status: "done",
    attempts: 1,
    generatedBy: "engine",
    createdAt: state.createdAt,
    filesChanged: [],
    result: {
      status: "done",
      summary: "Kiểm tra xong",
      filesChanged: ["src/example.ts"],
      testsRun: [{ suite: "unit", command: "npm test", passed: true, exitCode: 0 }],
      issues: [],
      nextSteps: [],
    },
  }];
  if (status === "awaiting_approval") {
    state.approvals = [{
      id: "approval-1",
      taskId: "be-1",
      role: "backend",
      tool: "shell_run",
      argsHash: "hash",
      summary: "Chạy lệnh cần duyệt",
      detail: "",
      reason: "Cần duyệt",
      status: "pending",
      createdAt: state.createdAt,
    }];
  }
  return state;
}

describe("Telegram run notifications", () => {
  it("reports disabled, incomplete, and ready configuration without exposing credentials", () => {
    expect(getTelegramConfigStatus({}).detail).toBe("đang tắt");
    expect(getTelegramConfigStatus({
      TELEGRAM_NOTIFY: "true",
      TELEGRAM_BOT_TOKEN: telegramEnv.TELEGRAM_BOT_TOKEN,
    })).toMatchObject({ enabled: true, configured: false, detail: "thiếu TELEGRAM_CHAT_ID" });
    expect(getTelegramConfigStatus(telegramEnv)).toMatchObject({ enabled: true, configured: true, detail: "sẵn sàng" });
    expect(JSON.stringify(getTelegramConfigStatus(telegramEnv))).not.toContain(telegramEnv.TELEGRAM_BOT_TOKEN);
  });

  it("reads credentials from .env without copying them into the process environment", () => {
    const workspace = tempWorkspace({
      files: {
        ".env": `TELEGRAM_BOT_TOKEN=${telegramEnv.TELEGRAM_BOT_TOKEN}\nTELEGRAM_CHAT_ID=${telegramEnv.TELEGRAM_CHAT_ID}\n`,
      },
    });
    const priorToken = process.env.TELEGRAM_BOT_TOKEN;
    const priorChatId = process.env.TELEGRAM_CHAT_ID;
    try {
      const config = getTelegramConfigStatus({ TELEGRAM_NOTIFY: "true" }, [`${workspace.dir}/.env`]);
      expect(config).toMatchObject({ enabled: true, configured: true, detail: "sẵn sàng" });
      expect(process.env.TELEGRAM_BOT_TOKEN).toBe(priorToken);
      expect(process.env.TELEGRAM_CHAT_ID).toBe(priorChatId);
    } finally {
      workspace.cleanup();
    }
  });

  it("creates a private-control API client for long polling and replies", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: [{ update_id: 77 }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
    const created = createTelegramControlApi({ env: telegramEnv, fetchImpl: fetchMock as typeof fetch });
    expect(created.status).toMatchObject({ enabled: true, configured: true });
    expect(created.api?.chatId).toBe(telegramEnv.TELEGRAM_CHAT_ID);

    const updates = await created.api!.getUpdates(77, new AbortController().signal);
    expect(updates[0]?.update_id).toBe(77);
    await created.api!.sendMessage("bot online");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://api.telegram.org/bot${telegramEnv.TELEGRAM_BOT_TOKEN}/getUpdates`);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ offset: 77, timeout: 25, allowed_updates: ["message"] });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ chat_id: telegramEnv.TELEGRAM_CHAT_ID, text: "bot online" });
  });

  it("sends a concise completion message and persists a deduplication marker", async () => {
    const workspace = tempWorkspace();
    try {
      const state = makeRun(workspace.dir);
      const runDir = `${workspace.dir}/runs/${state.id}`;
      prepareRunDir(runDir);
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const result = await notifyTelegramRunStatus(state, runDir, {
        env: telegramEnv,
        fetchImpl: fetchMock as typeof fetch,
        retryDelayMs: 0,
      });

      expect(result.status).toBe("sent");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain(telegramEnv.TELEGRAM_BOT_TOKEN);
      const payload = JSON.parse(String(init.body)) as { chat_id: string; text: string };
      expect(payload.chat_id).toBe(telegramEnv.TELEGRAM_CHAT_ID);
      expect(payload.text).toContain("Hoàn thành");
      expect(payload.text).toContain("1 đạt, 0 lỗi");
      expect(payload.text).not.toContain("source code");
      expect(payload.text).not.toContain(telegramEnv.TELEGRAM_BOT_TOKEN);
      expect(loadRun(runDir).telegramNotifications?.completed).toBeTruthy();

      expect((await notifyTelegramRunStatus(state, runDir, {
        env: telegramEnv,
        fetchImpl: fetchMock as typeof fetch,
      })).status).toBe("already_sent");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      workspace.cleanup();
    }
  });

  it("does not send when disabled or for non-final statuses", async () => {
    const workspace = tempWorkspace();
    try {
      const state = makeRun(workspace.dir);
      const fetchMock = vi.fn();
      expect((await notifyTelegramRunStatus(state, workspace.dir, { env: {}, fetchImpl: fetchMock })).status).toBe("disabled");
      state.status = "running";
      expect((await notifyTelegramRunStatus(state, workspace.dir, { env: telegramEnv, fetchImpl: fetchMock })).status).toBe("not_sendable");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      workspace.cleanup();
    }
  });

  it("retries bounded server failures without marking the notification sent", async () => {
    const workspace = tempWorkspace();
    try {
      const state = makeRun(workspace.dir, "failed");
      const runDir = `${workspace.dir}/runs/${state.id}`;
      prepareRunDir(runDir);
      const fetchMock = vi.fn()
        .mockResolvedValue(new Response("", { status: 503 }));
      const result = await notifyTelegramRunStatus(state, runDir, {
        env: telegramEnv,
        fetchImpl: fetchMock as typeof fetch,
        retryDelayMs: 0,
      });
      expect(result).toEqual({ status: "failed", detail: "Telegram API returned HTTP 503" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(state.telegramNotifications).toBeUndefined();
    } finally {
      workspace.cleanup();
    }
  });

  it("does not expose fetch errors that may contain the bot-token URL", async () => {
    const workspace = tempWorkspace();
    try {
      const state = makeRun(workspace.dir);
      const runDir = `${workspace.dir}/runs/${state.id}`;
      prepareRunDir(runDir);
      const fetchMock = vi.fn().mockRejectedValue(new Error(`failed at https://api.telegram.org/bot${telegramEnv.TELEGRAM_BOT_TOKEN}/sendMessage`));
      const result = await notifyTelegramRunStatus(state, runDir, {
        env: telegramEnv,
        fetchImpl: fetchMock as typeof fetch,
        retryDelayMs: 0,
      });
      expect(result).toEqual({ status: "failed", detail: "Telegram network request failed" });
      expect(JSON.stringify(result)).not.toContain(telegramEnv.TELEGRAM_BOT_TOKEN);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      workspace.cleanup();
    }
  });

  it("handles request timeouts without changing the run result", async () => {
    const workspace = tempWorkspace();
    try {
      const state = makeRun(workspace.dir);
      const runDir = `${workspace.dir}/runs/${state.id}`;
      prepareRunDir(runDir);
      const fetchMock = vi.fn().mockRejectedValue(new DOMException("deadline", "TimeoutError"));
      const result = await notifyTelegramRunStatus(state, runDir, {
        env: telegramEnv,
        fetchImpl: fetchMock as typeof fetch,
        retryDelayMs: 0,
      });
      expect(result).toEqual({ status: "failed", detail: "Telegram request timed out" });
      expect(state.status).toBe("completed");
      expect(state.telegramNotifications).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      workspace.cleanup();
    }
  });

  it("reports awaiting approval, bounds message length, and redacts bot tokens", () => {
    const workspace = tempWorkspace();
    try {
      const state = makeRun(workspace.dir, "awaiting_approval");
      state.request = `Yêu cầu ${"x".repeat(6000)} 123456:bot-token-with-enough-characters-123456`;
      const message = renderTelegramRunMessage(state);
      expect(message.length).toBeLessThanOrEqual(4096);
      expect(message).toContain("Đang chờ phê duyệt");
      expect(message).toContain("Approval đang chờ: 1");
      expect(message).not.toContain("123456:bot-token-with-enough-characters-123456");
    } finally {
      workspace.cleanup();
    }
  });

  it("includes failed task, test suite, and issue details in failure notifications", () => {
    const workspace = tempWorkspace();
    try {
      const state = makeRun(workspace.dir, "failed");
      const task = state.tasks[0]!;
      task.status = "failed";
      task.error = "LLM HTTP 400: missing thought_signature";
      task.result!.testsRun[0]!.passed = false;
      task.result!.issues = [{
        severity: "high",
        title: "Gemini từ chối tool call",
        detail: "Thiếu thought_signature khi gửi lại lịch sử hội thoại.",
      }];

      const message = renderTelegramRunMessage(state);
      expect(message).toContain("Suite lỗi: unit");
      expect(message).toContain("Task có vấn đề: 1");
      expect(message).toContain("LLM HTTP 400: missing thought_signature");
      expect(message).toContain("[high] Gemini từ chối tool call");
    } finally {
      workspace.cleanup();
    }
  });
});
