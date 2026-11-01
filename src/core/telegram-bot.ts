import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createTelegramControlApi, type TelegramBotUpdate } from "./telegram.js";
import { loadRun, listRuns, resolveRunDir } from "./state.js";
import { ensureDir, readJson, writeJson } from "../util/fsx.js";
import { PKG_ROOT, runsRoot } from "../config.js";
import { redactSecrets, truncate } from "../util/text.js";
import type { RunState } from "../types.js";

const STALE_ACTIVE_RUN_MS = 30 * 60 * 1000;

export interface TelegramCommandContext {
  authorizedChatId: string;
  sendMessage(text: string): Promise<void>;
  getStatus(runId?: string): string;
  getApprovals(runId?: string): string;
  startRun(request: string): Promise<void>;
  resumeRun(runId: string): Promise<void>;
  resolveApproval(runId: string, approvalId: string, decision: "approve" | "reject", reason?: string): Promise<void>;
}

export async function dispatchTelegramCommand(
  update: TelegramBotUpdate,
  context: TelegramCommandContext,
): Promise<void> {
  const message = update.message;
  if (!message?.text || message.from?.is_bot) return;
  if (message.chat?.type !== "private" || String(message.chat.id) !== context.authorizedChatId) return;

  const match = /^\s*\/([a-z]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?\s*$/i.exec(message.text);
  if (!match) return;
  const command = (match[1] ?? "").toLowerCase();
  const args = (match[2] ?? "").trim();

  try {
    switch (command) {
      case "start":
      case "help":
        await context.sendMessage([
          "Điều khiển Agent Team:",
          "/run <yêu cầu> — bắt đầu một run mới",
          "/status [runId|latest] — xem trạng thái",
          "/approvals [runId|latest] — xem việc chờ duyệt",
          "/approve <runId> <approvalId|all> — duyệt và chạy tiếp",
          "/reject <runId> <approvalId|all> [lý do] — từ chối và chạy tiếp",
          "/resume <runId> — tiếp tục run đang chờ",
          "Chỉ chat riêng có TELEGRAM_CHAT_ID được phép điều khiển.",
        ].join("\n"));
        return;
      case "run":
        if (!args) throw new Error("Cú pháp: /run <mô tả công việc cụ thể>");
        if (args.length > 2000) throw new Error("Yêu cầu dài quá 2000 ký tự; hãy chia thành các run nhỏ.");
        await context.startRun(args);
        return;
      case "status":
        await context.sendMessage(context.getStatus(args || "latest"));
        return;
      case "approvals":
        await context.sendMessage(context.getApprovals(args || "latest"));
        return;
      case "approve": {
        const [runId, approvalId, ...rest] = args.split(/\s+/);
        if (!runId || !approvalId || rest.length) throw new Error("Cú pháp: /approve <runId> <approvalId|all>");
        await context.resolveApproval(runId, approvalId, "approve");
        await context.resumeRun(runId);
        return;
      }
      case "reject": {
        const parts = args.split(/\s+/);
        const runId = parts.shift();
        const approvalId = parts.shift();
        if (!runId || !approvalId) throw new Error("Cú pháp: /reject <runId> <approvalId|all> [lý do]");
        await context.resolveApproval(runId, approvalId, "reject", parts.join(" "));
        await context.resumeRun(runId);
        return;
      }
      case "resume":
        if (!args || args.includes(" ")) throw new Error("Cú pháp: /resume <runId>");
        await context.resumeRun(args);
        return;
      default:
        await context.sendMessage("Lệnh chưa hỗ trợ. Gõ /help để xem các lệnh có thể dùng.");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Lệnh không thực hiện được.";
    await context.sendMessage(`Không thực hiện được: ${truncate(redactSecrets(detail), 1200)}`);
  }
}

export async function startTelegramControlBot(options: {
  workspace: string;
  envFiles: string[];
  runsDirectory?: string;
}): Promise<void> {
  const created = createTelegramControlApi({ envFiles: options.envFiles });
  if (!created.status.enabled) {
    throw new Error("Bật TELEGRAM_NOTIFY=true và cấu hình TELEGRAM_BOT_TOKEN cùng TELEGRAM_CHAT_ID trước khi chạy bot.");
  }
  if (!created.api) throw new Error(`Cấu hình Telegram chưa đủ: ${created.status.detail}.`);

  const api = created.api;
  const root = options.runsDirectory ?? runsRoot();
  const offsetFile = path.join(root, "telegram-bot-offset.json");
  ensureDir(root);
  let offset = readJson<{ offset?: number }>(offsetFile)?.offset ?? 0;
  const activeChildren = new Map<string, ChildProcess>();
  const context: TelegramCommandContext = {
    authorizedChatId: api.chatId,
    sendMessage: (text) => api.sendMessage(text),
    getStatus: (runId) => formatRunStatus(loadRun(resolveRunDir(root, validateRunId(runId)))),
    getApprovals: (runId) => formatApprovals(loadRun(resolveRunDir(root, validateRunId(runId)))),
    startRun: async (request) => {
      const staleRunIds = ensureNoActiveRun(root, activeChildren);
      await launchCli(activeChildren, ["run", request, "--no-interactive"], options.workspace, root, api);
      const staleNote = staleRunIds.length > 0
        ? `Bỏ qua state run cũ không cập nhật hơn 30 phút: ${staleRunIds.join(", ")}.`
        : undefined;
      await api.sendMessage([
        "Đã nhận yêu cầu và khởi chạy run. Gõ /status latest để theo dõi.",
        staleNote,
      ].filter(Boolean).join("\n"));
    },
    resumeRun: async (runId) => {
      const validatedId = validateRunId(runId);
      const state = loadRun(resolveRunDir(root, validatedId));
      if (state.status !== "awaiting_approval") {
        throw new Error(`Run ${state.id} đang ở trạng thái ${state.status}; chỉ run chờ duyệt mới tiếp tục được.`);
      }
      const staleRunIds = ensureNoActiveRun(root, activeChildren, state.id);
      await launchCli(activeChildren, ["resume", state.id, "--no-interactive"], options.workspace, root, api);
      const staleNote = staleRunIds.length > 0
        ? `Bỏ qua state run cũ không cập nhật hơn 30 phút: ${staleRunIds.join(", ")}.`
        : undefined;
      await api.sendMessage([`Đang tiếp tục run ${state.id}.`, staleNote].filter(Boolean).join("\n"));
    },
    resolveApproval: async (runId, approvalId, decision, reason) => {
      const validatedId = validateRunId(runId);
      const state = loadRun(resolveRunDir(root, validatedId));
      if (state.status !== "awaiting_approval") throw new Error(`Run ${state.id} không đang chờ duyệt.`);
      await execCli(
        decision === "approve"
          ? ["approve", state.id, approvalId]
          : ["reject", state.id, approvalId, reason || "Từ chối qua Telegram"],
        options.workspace,
      );
    },
  };

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await api.sendMessage("Telegram control bot đã kết nối. Gõ /help để xem lệnh.");
  console.log(`Telegram control bot đang nghe chat đã cấu hình (${api.chatId}). Nhấn Ctrl+C để dừng bot.`);

  try {
    while (!controller.signal.aborted) {
      let updates: TelegramBotUpdate[];
      try {
        updates = await api.getUpdates(offset, controller.signal);
      } catch {
        if (controller.signal.aborted) break;
        console.warn("Telegram polling gặp lỗi mạng/API; sẽ thử lại.");
        await delay(2000, controller.signal);
        continue;
      }
      for (const update of updates) {
        try {
          await dispatchTelegramCommand(update, context);
        } catch {
          console.warn("Không xử lý được một Telegram update.");
        }
        offset = Math.max(offset, update.update_id + 1);
        writeJson(offsetFile, { offset });
      }
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

function validateRunId(value?: string): string | undefined {
  if (!value || value === "latest") return value;
  if (!/^run-[A-Za-z0-9-]+$/.test(value)) throw new Error("runId không hợp lệ.");
  return value;
}

function ensureNoActiveRun(runsDirectory: string, children: Map<string, ChildProcess>, exceptRunId?: string): string[] {
  for (const child of children.values()) {
    if (child.exitCode === null && child.signalCode === null) throw new Error("Đang có một run do bot khởi chạy; hãy chờ hoặc dùng /status.");
  }
  const activeRuns = listRuns(runsDirectory).filter((run) =>
    run.id !== exceptRunId && ["planning", "running"].includes(run.status),
  );
  const cutoff = Date.now() - STALE_ACTIVE_RUN_MS;
  const recentRuns = activeRuns.filter((run) => {
    const updatedAt = Date.parse(run.updatedAt);
    // Invalid timestamps fail safe: they still block a new run.
    return !Number.isFinite(updatedAt) || updatedAt >= cutoff;
  });
  const active = recentRuns[0];
  if (active) throw new Error(`Run ${active.id} đang được ghi nhận là running; dùng /status ${active.id} để kiểm tra trước.`);
  return activeRuns.map((run) => run.id);
}

async function launchCli(
  children: Map<string, ChildProcess>,
  args: string[],
  workspace: string,
  runsDirectory: string,
  api: { sendMessage(text: string): Promise<void> },
): Promise<void> {
  const cliFile = path.join(PKG_ROOT, "dist", "cli.js");
  if (!fs.existsSync(cliFile)) throw new Error("Chưa build orchestrator. Chạy npm run build rồi khởi động lại bot.");
  const child = spawn(process.execPath, [cliFile, ...args], {
    cwd: workspace,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const key = `${Date.now()}-${Math.random()}`;
  children.set(key, child);
  let output = "";
  let announcedRun = false;
  let progressRunId = args[0] === "resume" ? args[1] : undefined;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  let progressInFlight = false;
  let lastProgressSignature = "";

  const publishProgress = async (runId: string): Promise<void> => {
    if (progressInFlight) return;
    progressInFlight = true;
    try {
      const state = loadRun(resolveRunDir(runsDirectory, runId));
      if (["planned", "awaiting_approval", "completed", "completed_with_issues", "failed", "cancelled"].includes(state.status)) return;
      const message = formatRunStatus(state);
      const signature = message;
      if (signature !== lastProgressSignature) {
        await api.sendMessage(message);
        lastProgressSignature = signature;
      }
    } catch {
      // Ignore transient state-file and Telegram failures; the next poll retries.
    } finally {
      progressInFlight = false;
    }
  };

  const startProgressWatch = (runId: string): void => {
    if (progressTimer) return;
    progressRunId = runId;
    void publishProgress(runId);
    progressTimer = setInterval(() => void publishProgress(runId), 1500);
  };

  const stopProgressWatch = (): void => {
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = undefined;
    if (!progressRunId) return;
    void (async () => {
      while (progressInFlight) await new Promise((resolve) => setTimeout(resolve, 50));
      await publishProgress(progressRunId!);
    })();
  };

  if (progressRunId) startProgressWatch(progressRunId);
  child.stdout?.on("data", (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-20_000);
    const runId = /\bRun\s+(run-[A-Za-z0-9-]+)(?=\s)/.exec(output)?.[1];
    if (runId && !announcedRun) {
      announcedRun = true;
      startProgressWatch(runId);
      void api.sendMessage(`Run ${runId} đã bắt đầu.`).catch(() => undefined);
    }
  });
  child.stderr?.on("data", () => {
    // CLI output may contain provider details. Never forward raw stderr to Telegram.
  });
  child.once("error", () => {
    stopProgressWatch();
    children.delete(key);
    void api.sendMessage("Không khởi chạy được tiến trình orchestrator.").catch(() => undefined);
  });
  child.once("exit", (code) => {
    stopProgressWatch();
    children.delete(key);
    if (!announcedRun && code !== 0) {
      void api.sendMessage(`Lệnh orchestrator kết thúc với mã ${code ?? "không rõ"}; kiểm tra cấu hình và log local.`)
        .catch(() => undefined);
    }
  });
}

async function execCli(args: string[], workspace: string): Promise<void> {
  const cliFile = path.join(PKG_ROOT, "dist", "cli.js");
  if (!fs.existsSync(cliFile)) throw new Error("Chưa build orchestrator. Chạy npm run build rồi khởi động lại bot.");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cliFile, ...args], {
      cwd: workspace,
      windowsHide: true,
      stdio: "ignore",
    });
    child.once("error", () => reject(new Error("Không khởi chạy được lệnh approval.")));
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Lệnh approval thất bại (mã ${code ?? "không rõ"}).`)));
  });
}

function formatRunStatus(state: RunState): string {
  const done = state.tasks.filter((task) => task.status === "done").length;
  const failed = state.tasks.filter((task) => ["failed", "blocked"].includes(task.status)).length;
  const pendingApprovals = state.approvals.filter((approval) => approval.status === "pending").length;
  const activeTasks = state.tasks.filter((task) => task.status === "in_progress");
  const tests = state.tasks.flatMap((task) => task.result?.testsRun ?? []);
  const testPassed = tests.filter((test) => test.passed).length;
  const quality = state.quality.passed === true ? "ĐẠT" : state.quality.passed === false ? "CHƯA ĐẠT" : "đang đánh giá";
  return [
    `Run ${state.id}: ${state.status} (${state.phase})`,
    `Task: ${done}/${state.tasks.length} hoàn tất${failed ? `, ${failed} lỗi/bị chặn` : ""}`,
    ...(activeTasks.length ? [`Đang làm: ${activeTasks.map((task) => `${task.id} · ${truncate(task.title, 100)}`).join("; ")}`] : []),
    `Test: ${tests.length ? `${testPassed}/${tests.length} đạt` : "chưa có kết quả"}`,
    `Quality: ${quality} · vòng ${state.quality.cycles}/${state.quality.maxCycles}`,
    ...(pendingApprovals ? [`Approval đang chờ: ${pendingApprovals}`] : []),
    ...(state.reportPath ? [`Báo cáo: ${state.reportPath}`] : []),
  ].join("\n");
}

function formatApprovals(state: RunState): string {
  const pending = state.approvals.filter((approval) => approval.status === "pending");
  if (pending.length === 0) return `Run ${state.id} không có approval đang chờ.`;
  return [
    `Approval đang chờ của ${state.id}:`,
    ...pending.slice(0, 8).flatMap((approval) => [
      `${approval.id} · ${approval.tool}: ${truncate(redactSecrets(approval.summary), 500)}`,
      `Duyệt: /approve ${state.id} ${approval.id}`,
      `Từ chối: /reject ${state.id} ${approval.id} <lý do>`,
    ]),
  ].join("\n");
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
