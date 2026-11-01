import path from "node:path";
import { classifyPath, classifyShell } from "../core/policy.js";
import { getGitInfo, gitStatusText, parseStatusPaths, runGit } from "../core/git.js";
import { PolicyDeniedError } from "../util/errors.js";
import { pathExists, toPosix } from "../util/fsx.js";
import { stableHash, tail, truncate } from "../util/text.js";
import { execShell, formatExecResult } from "./exec.js";
import {
  optionalNumber,
  optionalString,
  requireString,
  type ToolContext,
  type ToolDefinition,
  type ToolOutput,
} from "./types.js";

export const shellTools: ToolDefinition[] = [
  {
    name: "shell_run",
    description:
      "Chạy MỘT lệnh shell trong workspace (không nối lệnh, không cd). Dùng cho build/test/git đọc. Lệnh nguy hiểm sẽ bị chặn hoặc cần phê duyệt.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Lệnh cần chạy, ví dụ: 'npm run build'." },
        cwd: {
          type: "string",
          description: "Thư mục làm việc tương đối với workspace (mặc định '.').",
        },
        timeoutMs: { type: "integer", description: "Timeout (ms), tối đa theo cấu hình." },
        purpose: { type: "string", description: "Mục đích lệnh (ngắn gọn)." },
      },
      required: ["command"],
    },
    async execute(args, context) {
      return shellRun(args, context);
    },
  },
  {
    name: "git_status",
    description: "Xem branch, commit và danh sách file đang thay đổi (porcelain).",
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_args, context) {
      const info = getGitInfo(context.workspace);
      if (!info.isRepo) return { ok: false, output: "Workspace không phải git repo." };
      return {
        ok: true,
        output: [
          `branch: ${info.branch ?? "—"} · commit: ${info.commit ?? "—"}`,
          info.status.trim() || "(working tree sạch)",
        ].join("\n"),
      };
    },
  },
  {
    name: "git_diff",
    description:
      "Xem diff của thay đổi hiện tại (tracked + danh sách untracked). Dùng để tự kiểm tra trước khi báo hoàn thành.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Chỉ xem diff của file/thư mục (tuỳ chọn)." },
        statOnly: { type: "boolean", description: "Chỉ lấy thống kê (mặc định false)." },
      },
      required: [],
    },
    async execute(args, context) {
      const target = optionalString(args, "path");
      if (target) {
        const policy = classifyPath({
          workspace: context.workspace,
          target,
          operation: "read",
          config: context.config,
        });
        if (policy.decision === "deny") throw new PolicyDeniedError(policy.reason);
      }
      const statOnly = args.statOnly === true;
      const argsDiff = target ? ["diff", "--no-color", "--", target] : ["diff", "--no-color"];
      const diff = runGit(context.workspace, argsDiff);
      const stat = runGit(context.workspace, target ? ["diff", "--stat", "--", target] : ["diff", "--stat"]);
      const untracked = parseStatusPaths(gitStatusText(context.workspace))
        .filter((file) => file.endsWith("/") || !diff.stdout.includes(file))
        .slice(0, 50);
      const body = statOnly ? stat.stdout.trim() : diff.stdout.trim();
      const output = [
        body || "(không có diff tracked)",
        untracked.length > 0 ? `\nFile untracked/chưa stage:\n${untracked.join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return {
        ok: true,
        output: truncate(output, context.config.limits.maxToolOutputChars),
      };
    },
  },
];

async function shellRun(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput> {
  const command = requireString(args, "command", { maxLength: 4000 });
  const cwdInput = optionalString(args, "cwd") ?? ".";
  const purpose = optionalString(args, "purpose") ?? "(không ghi mục đích)";
  const requestedTimeout = optionalNumber(args, "timeoutMs");
  const timeoutMs = Math.max(
    1000,
    Math.min(requestedTimeout ?? context.config.limits.taskTimeoutMs, context.config.limits.taskTimeoutMs),
  );

  const absoluteCwd = path.isAbsolute(cwdInput)
    ? path.resolve(cwdInput)
    : path.resolve(context.workspace, cwdInput);
  const cwdPolicy = classifyPath({
    workspace: context.workspace,
    target: absoluteCwd,
    operation: "read",
    config: context.config,
  });
  if (cwdPolicy.decision === "deny") throw new PolicyDeniedError(cwdPolicy.reason);
  if (!pathExists(absoluteCwd)) {
    return { ok: false, output: `Thư mục làm việc không tồn tại: ${toPosix(cwdInput)}` };
  }

  const policy = classifyShell(command, context.config);
  await context.approvals.authorize({
    taskId: context.task.id,
    role: context.role,
    tool: "shell_run",
    argsHash: stableHash({ command, cwd: toPosix(cwdInput) }),
    summary: `Chạy lệnh: ${truncate(command, 240)}`,
    detail: `cwd=${toPosix(cwdInput)}\npurpose=${purpose}`,
    policy,
  });

  const result = await execShell({
    command,
    cwd: absoluteCwd,
    timeoutMs,
    maxOutputChars: 2_000_000,
  });
  const output = formatExecResult(result, context.config.limits.maxToolOutputChars);
  return {
    ok: result.ok,
    output: result.timedOut ? `${output}\n\nLệnh bị timeout sau ${timeoutMs}ms.` : output,
  };
}

export function formatStatus(workspace: string): string {
  return tail(gitStatusText(workspace) || "(working tree sạch)", 4000);
}
