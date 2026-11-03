#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  loadConfig,
  PKG_ROOT,
  redactedConfig,
  resolveWorkspace,
  runsRoot,
} from "./config.js";
import type { ConfigOverrides, LoadedConfig } from "./config.js";
import { createLLM } from "./llm/index.js";
import { Engine } from "./core/engine.js";
import {
  createRunState,
  listRuns,
  loadRun,
  prepareRunDir,
  resolveRunDir,
  runDirectory,
  saveRun,
  writeRequest,
} from "./core/state.js";
import { pendingApprovals, resolveApproval } from "./core/approvals.js";
import { printRunSummary, writeReport } from "./core/reporter.js";
import { serveRun } from "./server.js";
import { commandExists, diffStat, getGitInfo, gitStatusText } from "./core/git.js";
import type { RunState, TaskState } from "./types.js";
import { EventLogger } from "./util/logger.js";
import { errorMessage } from "./util/errors.js";
import { ensureDir, pathExists } from "./util/fsx.js";
import { truncate } from "./util/text.js";
import { pingLLM } from "./llm/openai.js";
import { getTelegramConfigStatus, notifyTelegramRunStatus } from "./core/telegram.js";
import { startTelegramControlBot } from "./core/telegram-bot.js";
import { startMcpServer } from "./mcp.js";

const BOOLEAN_FLAGS = new Set([
  "mock",
  "yes",
  "plan-only",
  "json",
  "verbose",
  "quiet",
  "open",
  "print",
  "online",
  "no-interactive",
  "help",
  "version",
]);

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | true>;
}

const EXIT_CODE: Record<string, number> = {
  completed: 0,
  planned: 0,
  awaiting_approval: 2,
  failed: 1,
  completed_with_issues: 3,
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("version")) {
    console.log("agent-team 0.1.0");
    return;
  }
  if (!args.command || args.command === "help" || args.flags.has("help")) {
    printHelp();
    return;
  }

  try {
    switch (args.command) {
      case "run":
      case "start":
        await commandRun(args, false);
        break;
      case "plan":
        await commandRun(args, true);
        break;
      case "resume":
        await commandResume(args);
        break;
      case "status":
        commandStatus(args);
        break;
      case "runs":
        commandRuns(args);
        break;
      case "approvals":
        commandApprovals(args);
        break;
      case "approve":
        commandApprove(args);
        break;
      case "reject":
        commandReject(args);
        break;
      case "report":
        commandReport(args);
        break;
      case "serve":
        await commandServe(args);
        break;
      case "doctor":
        await commandDoctor(args);
        break;
      case "telegram":
        await commandTelegram(args);
        break;
      case "mcp":
        await startMcpServer();
        break;
      case "version":
        console.log("agent-team 0.1.0");
        break;
      default:
        throw new Error(`Lệnh không hợp lệ: ${args.command}. Chạy "agent-team help".`);
    }
  } catch (error) {
    console.error(`\n❌ ${errorMessage(error)}`);
    if (args.flags.has("verbose") && error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exitCode = 1;
  }
}

async function commandRun(args: ParsedArgs, planOnly: boolean): Promise<void> {
  const request = args.positionals.slice(1).join(" ").trim();
  if (!request) {
    throw new Error('Thiếu yêu cầu. Ví dụ: npm run agent -- run "Thêm chức năng quên mật khẩu"');
  }

  const workspace = resolveWorkspace(flagString(args, "workspace"));
  const loaded = loadConfigForRun(args, workspace);
  const config = loaded.config;
  if (args.flags.has("mock")) config.provider.type = "mock";

  const logger = new EventLogger(undefined, {
    verbose: args.flags.has("verbose"),
    quiet: args.flags.has("quiet"),
  });
  for (const warning of loaded.warnings) logger.warn("config.warning", warning);
  logger.info("config", `Workspace: ${workspace}`);
  logger.info("config", `LLM: ${config.provider.type === "mock" ? "mock" : config.provider.model}`);

  // Khởi tạo LLM trước khi tạo run dir để thiếu API key không để lại run rác.
  const llm = createLLM(config);

  const git = getGitInfo(workspace);
  if (!git.isRepo) logger.warn("git", "Workspace không phải git repo; không thể theo dõi diff chính xác.");
  else if (git.dirtyAtStart) {
    logger.warn("git", "Workspace đang có thay đổi chưa commit. Diff của run sẽ lẫn với thay đổi cũ.");
  }

  const state = createRunState({
    request,
    workspace,
    mode: config.provider.type === "mock" ? "mock" : "live",
    git,
    maxFixCycles: config.limits.maxFixCycles,
  });
  const root = runsRoot();
  const dir = runDirectory(root, state.id);
  prepareRunDir(dir);
  writeRequest(dir, request, redactedConfig(config));
  saveRun(state, dir);

  logger.info("run.created", `Run ${state.id} · ${dir}`);
  const engine = new Engine({
    state,
    runDir: dir,
    workspace,
    config,
    llm,
    logger,
    autoApprove: args.flags.has("yes"),
    interactive: !args.flags.has("no-interactive"),
  });

  const finished = await engine.startNew(request, planOnly || args.flags.has("plan-only"));
  await notifyRunOnTelegram(finished, dir, logger);
  finish(finished, dir);
}

async function commandResume(args: ParsedArgs): Promise<void> {
  const runId = args.positionals[1];
  const root = runsRoot();
  const dir = resolveRunDir(root, runId);
  const state = loadRun(dir);
  const loaded = loadConfigForRun(args, state.workspace);
  const config = loaded.config;
  if (state.mode === "mock" || args.flags.has("mock")) config.provider.type = "mock";

  const logger = new EventLogger(undefined, {
    verbose: args.flags.has("verbose"),
    quiet: args.flags.has("quiet"),
  });
  for (const warning of loaded.warnings) logger.warn("config.warning", warning);
  logger.info("run.resume", `Run ${state.id} · ${state.workspace}`);

  if (state.status === "completed") {
    logger.warn("run.resume", "Run đã hoàn thành; resume sẽ chạy thêm vòng kiểm thử nếu được phép.");
  }

  const llm = createLLM(config);
  const engine = new Engine({
    state,
    runDir: dir,
    workspace: state.workspace,
    config,
    llm,
    logger,
    autoApprove: args.flags.has("yes"),
    interactive: !args.flags.has("no-interactive"),
  });
  const finished = await engine.resume();
  await notifyRunOnTelegram(finished, dir, logger);
  finish(finished, dir);
}

function commandStatus(args: ParsedArgs): void {
  const dir = resolveRunDir(runsRoot(), args.positionals[1]);
  const state = loadRun(dir);
  if (args.flags.has("json")) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  const counts = countStatuses(state.tasks);
  console.log("");
  console.log(`Run:      ${state.id}`);
  console.log(`Trạng thái: ${state.status} (${state.phase})`);
  console.log(`Mode:     ${state.mode}`);
  console.log(`Workspace:${state.workspace}`);
  console.log(`Tạo lúc:  ${state.createdAt}`);
  console.log(`Cập nhật: ${state.updatedAt}`);
  console.log(`Yêu cầu:  ${truncate(state.request.replace(/\r?\n/g, " "), 300)}`);
  console.log("");
  console.log(
    `Task: ${counts.done ?? 0}/${state.tasks.length} xong · ${counts.failed ?? 0} lỗi · ${
      counts.blocked ?? 0
    } blocked · ${counts.needs_approval ?? 0} chờ duyệt · ${counts.skipped ?? 0} bỏ qua`,
  );
  console.log(
    `Quality: ${state.quality.passed === undefined ? "chưa chạy" : state.quality.passed ? "ĐẠT" : "CHƯA ĐẠT"} · cycles ${
      state.quality.cycles
    }/${state.quality.maxCycles}`,
  );
  console.log(
    `Token: ${state.usage.promptTokens + state.usage.completionTokens} · LLM calls: ${state.usage.calls}`,
  );
  console.log("");

  if (state.tasks.length > 0) {
    console.log("Tasks:");
    printTaskTable(state.tasks);
  }
  if (state.quality.history.length > 0) {
    console.log("Vòng kiểm thử:");
    for (const item of state.quality.history) {
      console.log(
        `  ${item.cycle}. ${item.verifyTaskId} → ${item.passed ? "ĐẠT" : "CHƯA ĐẠT"} (${item.blockingIssues} blocking) · ${truncate(item.summary, 120)}`,
      );
    }
  }
  const pending = pendingApprovals(state);
  if (pending.length > 0) {
    console.log("");
    console.log(`⚠ ${pending.length} approval đang chờ:`);
    for (const approval of pending) {
      console.log(`  ${approval.id} · ${approval.taskId} · ${approval.summary}`);
    }
    console.log(`Duyệt: npm run agent -- approve ${state.id} ${pending[0]?.id ?? "<id>"}`);
    console.log(`Sau đó: npm run agent -- resume ${state.id}`);
  }
  if (state.error) console.log(`\nLỗi run: ${state.error}`);
  if (state.reportPath) console.log(`\nBáo cáo: ${state.reportPath}`);
  console.log("");
}

function commandRuns(args: ParsedArgs): void {
  const runs = listRuns(runsRoot());
  if (runs.length === 0) {
    console.log("Chưa có run nào. Chạy: npm run agent -- run \"...\"");
    return;
  }
  if (args.flags.has("json")) {
    console.log(JSON.stringify(runs, null, 2));
    return;
  }
  console.log("");
  console.log("ID                             Trạng thái               Task     Cập nhật             Yêu cầu");
  console.log("─".repeat(120));
  for (const run of runs) {
    console.log(
      `${run.id.padEnd(30)} ${run.status.padEnd(24)} ${`${run.doneCount}/${run.taskCount}`.padEnd(8)} ${
        run.updatedAt.slice(0, 19).replace("T", " ")
      }  ${truncate(run.request.replace(/\r?\n/g, " "), 40)}`,
    );
  }
  console.log("");
}

function commandApprovals(args: ParsedArgs): void {
  const dir = resolveRunDir(runsRoot(), args.positionals[1]);
  const state = loadRun(dir);
  const all = state.approvals;
  if (all.length === 0) {
    console.log("Run này không có approval nào.");
    return;
  }
  console.log("");
  for (const approval of all) {
    console.log(`ID:       ${approval.id}`);
    console.log(`Task:     ${approval.taskId} (${approval.role}) · tool ${approval.tool}`);
    console.log(`Trạng thái: ${approval.status}`);
    console.log(`Hành động: ${approval.summary}`);
    console.log(`Lý do:    ${approval.reason}`);
    console.log(`Chi tiết:`);
    console.log(
      approval.detail
        .split(/\r?\n/)
        .map((line) => `  ${line}`)
        .join("\n"),
    );
    if (approval.resolvedAt) console.log(`Xử lý:    ${approval.resolvedAt} · ${approval.resolution ?? ""}`);
    console.log("─".repeat(80));
  }
  const pending = pendingApprovals(state);
  if (pending.length > 0) {
    console.log(`Duyệt tất cả: npm run agent -- approve ${state.id} all`);
    console.log(`Sau đó:       npm run agent -- resume ${state.id}`);
  }
  console.log("");
}

function commandApprove(args: ParsedArgs): void {
  const runId = args.positionals[1];
  const approvalId = args.positionals[2];
  if (!runId || !approvalId) throw new Error("Dùng: approve <runId> <approvalId|all>");
  const dir = resolveRunDir(runsRoot(), runId);
  const state = loadRun(dir);
  const resolved = resolveApproval(state, approvalId, "approved", "Phê duyệt qua CLI");
  saveRun(state, dir);
  console.log(`✅ Đã duyệt ${resolved.length} approval: ${resolved.map((item) => item.id).join(", ")}`);
  if (state.status === "awaiting_approval") {
    console.log(`Tiếp tục: npm run agent -- resume ${state.id}`);
  }
}

function commandReject(args: ParsedArgs): void {
  const runId = args.positionals[1];
  const approvalId = args.positionals[2];
  if (!runId || !approvalId) throw new Error("Dùng: reject <runId> <approvalId|all> [lý do]");
  const reason = args.positionals.slice(3).join(" ") || "Người dùng từ chối qua CLI";
  const dir = resolveRunDir(runsRoot(), runId);
  const state = loadRun(dir);
  const resolved = resolveApproval(state, approvalId, "rejected", reason);
  saveRun(state, dir);
  console.log(`❌ Đã từ chối ${resolved.length} approval: ${resolved.map((item) => item.id).join(", ")}`);
  console.log(`Agent sẽ thử cách khác khi resume: npm run agent -- resume ${state.id}`);
}

function commandReport(args: ParsedArgs): void {
  const dir = resolveRunDir(runsRoot(), args.positionals[1]);
  const state = loadRun(dir);
  let reportPath = state.reportPath;
  if (!reportPath || !pathExists(reportPath)) {
    const config = loadConfig({
      workspace: state.workspace,
      configPath: flagString(args, "config"),
    }).config;
    reportPath = writeReport(state, dir, config);
    saveRun(state, dir);
  }
  console.log(`Báo cáo: ${reportPath}`);
  if (args.flags.has("print")) {
    console.log("");
    console.log(fs.readFileSync(reportPath, "utf8"));
  }
  if (args.flags.has("open")) openFile(reportPath);
}

async function commandServe(args: ParsedArgs): Promise<void> {
  const port = flagNumber(args, "port") ?? 4317;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--port phải là số nguyên trong khoảng 1..65535.");
  }
  const host = flagString(args, "host") ?? "127.0.0.1";
  const runId = args.positionals[1];
  await serveRun({ runId, port, host });
}

async function commandTelegram(args: ParsedArgs): Promise<void> {
  const workspace = resolveWorkspace(flagString(args, "workspace"));
  loadConfig({ workspace, configPath: flagString(args, "config") });
  await startTelegramControlBot({
    workspace,
    envFiles: [path.join(workspace, ".env"), path.join(PKG_ROOT, ".env")],
  });
}

async function commandDoctor(args: ParsedArgs): Promise<void> {
  const workspace = resolveWorkspace(flagString(args, "workspace"));
  const loaded = loadConfigForRun(args, workspace);
  const config = loaded.config;
  if (args.flags.has("mock")) config.provider.type = "mock";
  const rows: Array<[string, boolean | null, string]> = [];
  rows.push(["Node >= 20", Number(process.versions.node.split(".")[0]) >= 20, process.version]);
  rows.push(["Workspace tồn tại", pathExists(workspace), workspace]);
  const git = getGitInfo(workspace);
  rows.push(["Git repo", git.isRepo, git.isRepo ? `${git.branch} @ ${git.commit}` : "không phải repo"]);
  const apiReady = config.provider.type === "mock" || config.provider.type === "opencode" || Boolean(config.provider.apiKey);
  rows.push([
    config.provider.type === "opencode" ? "OpenCode server" : "API key",
    apiReady,
    config.provider.type === "mock"
      ? "mock mode"
      : config.provider.type === "opencode"
        ? `${config.provider.opencodeServerUrl || "http://127.0.0.1:4096"} · ${config.provider.model}`
      : apiReady
        ? `đã có (${config.provider.apiKeyEnv})`
        : `thiếu ${config.provider.apiKeyEnv}`,
  ]);
  rows.push(["Config", true, loaded.configPath ?? "(mặc định)"]);
  const telegram = getTelegramConfigStatus(process.env, [
    path.join(workspace, ".env"),
    path.join(PKG_ROOT, ".env"),
  ]);
  rows.push([
    "Telegram",
    telegram.enabled ? telegram.configured : null,
    telegram.detail,
  ]);
  rows.push(["npm", commandExists("npm"), commandExists("npm") ? "sẵn sàng" : "không tìm thấy"]);
  const mvnw = path.join(workspace, "backend", process.platform === "win32" ? "mvnw.cmd" : "mvnw");
  const java = commandExists("java");
  rows.push([
    "Maven wrapper",
    pathExists(mvnw),
    pathExists(mvnw) ? path.relative(workspace, mvnw).split(path.sep).join("/") : "không tìm thấy",
  ]);
  rows.push(["Java", java, java ? "sẵn sàng" : "không tìm thấy (cần cho backend test)"]);
  for (const [name, suite] of Object.entries(config.tests)) {
    rows.push([`Test suite: ${name}`, true, `${suite.command} (cwd: ${suite.cwd})`]);
  }

  const root = runsRoot();
  let writable = true;
  try {
    ensureDir(root);
    const probe = path.join(root, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
  } catch {
    writable = false;
  }
  rows.push(["Thư mục runs", writable, root]);

  console.log("");
  for (const [label, ok, detail] of rows) {
    const icon = ok === null ? "•" : ok ? "✅" : "❌";
    console.log(`${icon} ${label.padEnd(22)} ${detail}`);
  }
  console.log("");
  if (args.flags.has("online")) {
    if (!apiReady) {
      console.log("⚠ Bỏ qua kiểm tra LLM vì thiếu API key.");
    } else {
      console.log("Đang kiểm tra LLM…");
      try {
        console.log(`✅ ${await pingLLM(createLLM(config))}`);
      } catch (error) {
        console.log(`❌ LLM: ${errorMessage(error)}`);
        process.exitCode = 1;
      }
    }
  }
  if (rows.some(([, ok]) => ok === false)) {
    console.log("⚠ Có mục chưa sẵn sàng — xem hướng dẫn trong orchestrator/README.md.");
    process.exitCode = 1;
  }
}

function finish(state: RunState, dir: string): void {
  const code = EXIT_CODE[state.status] ?? 1;
  process.exitCode = code;
  console.log("");
  console.log(printRunSummary(state));
  console.log(`Run dir: ${dir}`);
  if (state.status === "awaiting_approval") {
    const pending = pendingApprovals(state);
    console.log("");
    console.log(`⏸  Đang chờ ${pending.length} approval.`);
    console.log(`   Xem:   npm run agent -- approvals ${state.id}`);
    console.log(`   Duyệt: npm run agent -- approve ${state.id} ${pending[0]?.id ?? "<id>"}`);
    console.log(`   Chạy tiếp: npm run agent -- resume ${state.id}`);
  } else if (state.status === "completed") {
    console.log("");
    console.log("✅ Hoàn thành. Hãy review diff trước khi commit/merge:");
    console.log("   " + truncate(gitStatusText(state.workspace) || "(working tree sạch)", 2000).split("\n")[0]);
    console.log("   " + truncate(diffStat(state.workspace) || "(không có diff)", 2000).split("\n")[0]);
  } else if (state.status === "planned") {
    console.log("");
    console.log("📝 Đã lập kế hoạch. Chạy lại không có --plan-only để thực thi.");
  } else if (state.status === "completed_with_issues") {
    console.log("");
    console.log("⚠ Hoàn thành nhưng còn vấn đề — xem mục 'Vấn đề còn tồn tại' trong báo cáo.");
  }
  console.log(`📄 Báo cáo: ${state.reportPath ?? path.join(dir, "report.md")}`);
}

async function notifyRunOnTelegram(state: RunState, runDir: string, logger: EventLogger): Promise<void> {
  const result = await notifyTelegramRunStatus(state, runDir, {
    envFiles: [path.join(state.workspace, ".env"), path.join(PKG_ROOT, ".env")],
  });
  if (result.status === "sent") {
    const detail = result.detail ? ` Cảnh báo: ${result.detail}.` : "";
    new EventLogger(runDir, { quiet: true }).info("telegram.sent", `Đã gửi thông báo Telegram cho run ${state.id} (${state.status}).${detail}`);
  } else if (result.status === "failed" || result.status === "misconfigured") {
    new EventLogger(runDir, { quiet: true }).warn(
      "telegram.notification_failed",
      `Không gửi được thông báo Telegram: ${result.detail ?? "cấu hình chưa hợp lệ"}. Run vẫn giữ nguyên kết quả.`,
    );
    logger.warn("telegram.notification_failed", `Không gửi được thông báo Telegram: ${result.detail ?? "cấu hình chưa hợp lệ"}. Run vẫn giữ nguyên kết quả.`);
  }
}

function loadConfigForRun(args: ParsedArgs, workspace: string): LoadedConfig {
  const overrides: ConfigOverrides = {};
  const model = flagString(args, "model");
  const baseUrl = flagString(args, "base-url");
  if (model || baseUrl) {
    overrides.provider = {
      ...(model ? { model } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    };
  }
  const maxCycles = flagNumber(args, "max-cycles");
  if (maxCycles !== undefined) {
    overrides.maxFixCycles = maxCycles;
    overrides.limits = { maxFixCycles: maxCycles };
  }
  const parallel = flagNumber(args, "parallel");
  if (parallel !== undefined) {
    if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) {
      throw new Error("--parallel phải là số nguyên trong khoảng 1..8.");
    }
    overrides.limits = { ...(overrides.limits ?? {}), maxParallel: parallel };
  }
  return loadConfig({
    workspace,
    configPath: flagString(args, "config"),
    overrides,
  });
}

function printTaskTable(tasks: TaskState[]): void {
  console.log("  ID                 Agent     Trạng thái     Cố gắng  Kết quả");
  for (const task of tasks) {
    console.log(
      `  ${task.id.padEnd(18)} ${task.role.padEnd(9)} ${task.status.padEnd(14)} ${String(
        task.attempts,
      ).padEnd(8)} ${truncate(task.result?.summary ?? task.error ?? "—", 80)}`,
    );
  }
}

function countStatuses(tasks: TaskState[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return counts;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  let terminated = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (terminated) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      terminated = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const [rawKey, inline] = arg.slice(2).split("=", 2);
      const key = rawKey ?? "";
      if (!key) continue;
      if (inline !== undefined) {
        flags.set(key, inline);
        continue;
      }
      if (BOOLEAN_FLAGS.has(key)) {
        flags.set(key, true);
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        index += 1;
      } else {
        flags.set(key, true);
      }
      continue;
    }
    positionals.push(arg);
  }
  return {
    command: positionals[0] ?? "",
    positionals,
    flags,
  };
}

function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const value = flagString(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${name} phải là số >= 0.`);
  return parsed;
}

function openFile(file: string): void {
  const command =
    process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", file] : [file];
  spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

function printHelp(): void {
  console.log(`
🤖 Agent Team — 4 AI Agent phối hợp phát triển phần mềm

CÁCH DÙNG
  npm run agent -- <lệnh> [tham số]

LỆNH CHÍNH
  run "<yêu cầu>"       Chạy toàn bộ quy trình: plan → implement → test → debug → report
  plan "<yêu cầu>"      Chỉ lập kế hoạch, không sửa code
  resume [runId]        Tiếp tục run đang chờ phê duyệt hoặc chưa xong
  status [runId]        Xem tiến độ chi tiết
  runs                  Liệt kê các run
  approvals [runId]     Xem các hành động cần phê duyệt
  approve <runId> <id|all>   Phê duyệt
  reject  <runId> <id|all> [lý do]  Từ chối
  report  [runId]       Đường dẫn báo cáo (--print để in, --open để mở)
  serve   [runId]       Web dashboard realtime (SSE) + duyệt approval
  doctor                Kiểm tra môi trường (--online để ping LLM)
  telegram              Bật bot Telegram để nhận lệnh điều khiển từ chat riêng
  mcp                   Chạy MCP server qua stdio cho client MCP
  help                  Trợ giúp

TUỲ CHỌN
  --workspace <path>    Repo đích (mặc định: repo chứa orchestrator/)
  --config <path>       File cấu hình (mặc định: orchestrator/agent.config.json)
  --mock                Chạy không cần API key, không sửa code (smoke test)
  --yes                 Tự động phê duyệt hành động rủi ro
  --plan-only           Như lệnh plan
  --max-cycles <n>      Số vòng Debug tối đa
  --parallel <n>        Số task chạy song song tối đa (1..8)
  --model <name>        Ghi đè model
  --base-url <url>      Ghi đè OpenAI-compatible base URL
  --port <n>            Cổng dashboard khi dùng serve (mặc định 4317)
  --host <host>         Host dashboard khi dùng serve (mặc định 127.0.0.1)
  --verbose             Log chi tiết
  --quiet               Không in log ra stdout (vẫn ghi events.jsonl)
  --json                Xuất JSON (status/runs)
  --print / --open      In/mở báo cáo
  --no-interactive      Không hỏi trực tiếp; tạo approval và tạm dừng

VÍ DỤ
  npm run agent -- doctor --online
  npm run agent -- plan "Thêm màn hình quản lý nhà cung cấp"
  npm run agent -- run "Thêm API và màn hình quản lý nhà cung cấp" --yes
  npm run agent -- run "Sửa lỗi tính tồn kho khi huỷ đơn" --no-interactive
  npm run agent -- status latest
  npm run agent -- serve latest --port 4317
  node dist/cli.js telegram
  npm run agent -- approve run-20261019-101500-abcd apr-12345678
  npm run agent -- resume run-20261019-101500-abcd

QUY TRÌNH
  1. Planner phân rã yêu cầu thành DAG task backend/frontend.
  2. Orchestrator giao task theo dependency, chạy song song tối đa --parallel task khác role.
  3. Testing Agent chạy test/build; nếu fail, Debug Agent phân tích root cause và sửa.
  4. Vòng test → debug lặp tối đa --max-cycles (mặc định 3).
  5. Báo cáo Markdown/JSON; không tự commit/push.

AN TOÀN
  - Sandbox đường dẫn trong workspace; chặn .env, .git, secret.
  - Chặn git push/reset --hard, rm -rf, deploy, publish...
  - Hành động rủi ro cần phê duyệt (--yes để tự duyệt).
  - Mọi thay đổi nằm trong working tree để bạn review.
`);
}

main();
