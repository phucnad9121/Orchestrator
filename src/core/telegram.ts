import type { RunState, RunStatus } from "../types.js";
import { saveRun } from "./state.js";
import { diffStat } from "./git.js";
import { redactSecrets, truncate } from "../util/text.js";
import fs from "node:fs";

const TELEGRAM_MESSAGE_LIMIT = 4096;
const SENDABLE_STATUSES = new Set<RunStatus>([
  "awaiting_approval",
  "completed",
  "completed_with_issues",
  "failed",
  "cancelled",
]);

export interface TelegramConfigStatus {
  enabled: boolean;
  configured: boolean;
  detail: string;
}

interface TelegramRuntimeConfig extends TelegramConfigStatus {
  botToken?: string;
  chatId?: string;
}

export interface TelegramSendResult {
  status: "disabled" | "misconfigured" | "not_sendable" | "already_sent" | "sent" | "failed";
  detail?: string;
}

export interface TelegramBotUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat?: { id?: number | string; type?: string };
    from?: { is_bot?: boolean };
  };
}

export interface TelegramControlApi {
  readonly chatId: string;
  getUpdates(offset: number, signal: AbortSignal): Promise<TelegramBotUpdate[]>;
  sendMessage(text: string): Promise<void>;
}

function resolveTelegramConfig(
  env: NodeJS.ProcessEnv = process.env,
  envFiles: string[] = [],
): TelegramRuntimeConfig {
  const enabled = env.TELEGRAM_NOTIFY?.trim().toLowerCase() === "true";
  // Read .env credentials into this short-lived config object instead of process.env,
  // so child shells/tools do not inherit the Telegram bot token.
  const fileEnv = readTelegramSecrets(envFiles);
  const botToken = (env.TELEGRAM_BOT_TOKEN ?? fileEnv.TELEGRAM_BOT_TOKEN)?.trim();
  const chatId = (env.TELEGRAM_CHAT_ID ?? fileEnv.TELEGRAM_CHAT_ID)?.trim();
  const configured = Boolean(botToken && chatId);

  if (!enabled) {
    return {
      enabled: false,
      configured,
      detail: configured ? "đã cấu hình nhưng đang tắt" : "đang tắt",
    };
  }
  if (!configured) {
    const missing = [
      !botToken ? "TELEGRAM_BOT_TOKEN" : undefined,
      !chatId ? "TELEGRAM_CHAT_ID" : undefined,
    ].filter(Boolean);
    return { enabled: true, configured: false, detail: `thiếu ${missing.join(" và ")}` };
  }
  return { enabled: true, configured: true, detail: "sẵn sàng", botToken, chatId };
}

export function getTelegramConfigStatus(
  env: NodeJS.ProcessEnv = process.env,
  envFiles: string[] = [],
): TelegramConfigStatus {
  const { enabled, configured, detail } = resolveTelegramConfig(env, envFiles);
  return { enabled, configured, detail };
}

export function createTelegramControlApi(options: {
  env?: NodeJS.ProcessEnv;
  envFiles?: string[];
  fetchImpl?: typeof fetch;
} = {}): { status: TelegramConfigStatus; api?: TelegramControlApi } {
  const config = resolveTelegramConfig(options.env, options.envFiles);
  const status = { enabled: config.enabled, configured: config.configured, detail: config.detail };
  if (!config.enabled || !config.configured || !config.botToken || !config.chatId) return { status };

  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `https://api.telegram.org/bot${config.botToken}`;
  const request = async <T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    let response: Response;
    try {
      response = await fetchImpl(`${endpoint}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error("Telegram network request failed");
    }
    let data: { ok?: boolean; result?: T };
    try {
      data = await response.json() as { ok?: boolean; result?: T };
    } catch {
      throw new Error(`Telegram API returned HTTP ${response.status}`);
    }
    if (!response.ok || data.ok !== true) {
      throw new Error(`Telegram API returned HTTP ${response.status}`);
    }
    return data.result as T;
  };

  return {
    status,
    api: {
      chatId: config.chatId,
      getUpdates: (offset, signal) => request<TelegramBotUpdate[]>("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message"],
      }, signal),
      sendMessage: async (text) => {
        const safeText = Array.from(redactSecrets(text).replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_BOT_TOKEN]"))
          .slice(0, TELEGRAM_MESSAGE_LIMIT).join("");
        await request("sendMessage", { chat_id: config.chatId, text: safeText });
      },
    },
  };
}

export function renderTelegramRunMessage(state: RunState): string {
  const statusLabels: Record<RunStatus, string> = {
    initializing: "Đang khởi tạo",
    planning: "Đang lập kế hoạch",
    planned: "Đã lập kế hoạch",
    running: "Đang chạy",
    awaiting_approval: "Đang chờ phê duyệt",
    completed: "Hoàn thành",
    completed_with_issues: "Hoàn thành, còn vấn đề",
    failed: "Thất bại",
    cancelled: "Đã hủy",
  };
  const tests = state.tasks.flatMap((task) => task.result?.testsRun ?? []);
  const passed = tests.filter((test) => test.passed).length;
  const failed = tests.length - passed;
  const failedSuites = [...new Set(tests.filter((test) => !test.passed).map((test) => test.suite))];
  const changedFiles = new Set(
    state.tasks.flatMap((task) => task.result?.filesChanged ?? task.filesChanged),
  );
  const problemTasks = state.tasks.filter(
    (task) => ["failed", "blocked"].includes(task.status) || Boolean(task.error),
  );
  const issues = state.tasks.flatMap((task) =>
    (task.result?.issues ?? []).map((issue) => ({ taskId: task.id, ...issue })),
  );
  let changes = "không lấy được diff stat";
  try {
    changes = diffStat(state.workspace) || "không có diff tracked";
  } catch {
    // Báo cáo Telegram không được phụ thuộc vào khả năng chạy git.
  }

  const lines = [
    `🤖 Orchestrator · ${state.id}`,
    `Trạng thái: ${statusLabels[state.status] ?? state.status}`,
    `Yêu cầu: ${truncate(state.request.replace(/[\r\n\t]+/g, " ").trim(), 500)}`,
    `Kiểm tra: ${tests.length ? `${passed} đạt, ${failed} lỗi` : "chưa có test record"}`,
    ...(failedSuites.length ? [`Suite lỗi: ${failedSuites.join(", ")}`] : []),
    `File agent báo thay đổi: ${changedFiles.size}`,
    `Diff: ${truncate(changes.replace(/[\r\n]+/g, " "), 500)}`,
  ];
  if (problemTasks.length) {
    lines.push(`Task có vấn đề: ${problemTasks.length}`);
    for (const task of problemTasks.slice(0, 4)) {
      lines.push(`- ${task.id} (${task.role}): ${truncate((task.error ?? task.result?.summary ?? task.status).replace(/[\r\n]+/g, " "), 450)}`);
    }
  }
  if (issues.length) {
    lines.push(`Issue agent ghi nhận: ${issues.length}`);
    for (const issue of issues.slice(0, 3)) {
      lines.push(`- [${issue.severity}] ${truncate(`${issue.title}: ${issue.detail}`.replace(/[\r\n]+/g, " "), 450)}`);
    }
  }
  if (state.quality.blockedReason) {
    lines.push(`Chất lượng: ${truncate(state.quality.blockedReason.replace(/[\r\n]+/g, " "), 500)}`);
  }
  if (state.error) lines.push(`Lỗi: ${truncate(state.error.replace(/[\r\n]+/g, " "), 500)}`);
  if (state.status === "awaiting_approval") {
    const pending = state.approvals.filter((approval) => approval.status === "pending");
    lines.push(`Approval đang chờ: ${pending.length}`);
    for (const approval of pending.slice(0, 3)) {
      lines.push(`- ${approval.summary}`);
    }
    lines.push(`Xem và duyệt: npm run agent -- approvals ${state.id}`);
  }
  if (state.reportPath) lines.push(`Báo cáo local: ${state.reportPath}`);

  // Telegram giới hạn 4096 ký tự cho sendMessage. Dùng plain text, không parse Markdown.
  const safeMessage = redactSecrets(lines.join("\n")).replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_BOT_TOKEN]");
  return Array.from(safeMessage).slice(0, TELEGRAM_MESSAGE_LIMIT).join("");
}

export async function notifyTelegramRunStatus(
  state: RunState,
  runDir: string,
  options: {
    env?: NodeJS.ProcessEnv;
    envFiles?: string[];
    fetchImpl?: typeof fetch;
    retryDelayMs?: number;
  } = {},
): Promise<TelegramSendResult> {
  if (!SENDABLE_STATUSES.has(state.status)) return { status: "not_sendable" };
  const config = resolveTelegramConfig(options.env, options.envFiles);
  if (!config.enabled) return { status: "disabled" };
  if (!config.configured || !config.botToken || !config.chatId) {
    return { status: "misconfigured", detail: config.detail };
  }
  if (state.telegramNotifications?.[state.status]) return { status: "already_sent" };

  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  let lastFailure = "Telegram API request failed";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: config.chatId,
          text: renderTelegramRunMessage(state).replaceAll(config.botToken, "[REDACTED_BOT_TOKEN]"),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        let telegramOk = true;
        try {
          const body = (await response.json()) as { ok?: unknown };
          telegramOk = body.ok !== false;
        } catch {
          // Some compatible gateways return an empty success response.
        }
        if (telegramOk) {
          state.telegramNotifications ??= {};
          state.telegramNotifications[state.status] = new Date().toISOString();
          try {
            saveRun(state, runDir);
          } catch {
            // The Telegram message was delivered; do not retry and risk sending a duplicate.
            return { status: "sent", detail: "notification marker could not be persisted" };
          }
          return { status: "sent" };
        }
        lastFailure = "Telegram API rejected the message";
      } else {
        lastFailure = `Telegram API returned HTTP ${response.status}`;
        if (response.status < 500 && response.status !== 429) break;
      }
    } catch (error) {
      // Do not surface fetch errors: some runtimes include the bot-token URL in them.
      lastFailure = error instanceof Error && error.name === "TimeoutError"
        ? "Telegram request timed out"
        : "Telegram network request failed";
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 250));
  }
  return { status: "failed", detail: lastFailure };
}

function readTelegramSecrets(files: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const file of files) {
    try {
      for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const match = /^\s*(?:export\s+)?(TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)\s*=\s*(.*?)\s*$/.exec(rawLine);
        if (!match?.[1] || !match[2] || values[match[1]]) continue;
        let value = match[2];
        if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        values[match[1]] = value;
      }
    } catch {
      // Missing or unreadable optional .env files are reported as missing config by doctor.
    }
  }
  return values;
}

