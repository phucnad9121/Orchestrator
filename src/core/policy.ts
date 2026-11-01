import path from "node:path";
import type { AgentConfig } from "../types.js";
import { isSubPath, matchesAnyGlob, normalizeRelative, toPosix } from "../util/fsx.js";

export type PolicyDecision = "allow" | "ask" | "deny";

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
}

const ALWAYS_DENIED_COMMANDS = [/^\s*$/, /[\r\n]/, /&&|\|\||;|\|/, /\$\(/, /`/, /^\s*cd\s/i, /\s&\s/];
const REDIRECTION = /(^|\s)(>>?|<)\s*\S/;

export function classifyShell(command: string, config: AgentConfig): PolicyResult {
  const trimmed = command.trim();
  if (!trimmed) return { decision: "deny", reason: "Lệnh rỗng." };

  for (const rule of ALWAYS_DENIED_COMMANDS) {
    if (rule.test(trimmed)) {
      return {
        decision: "deny",
        reason:
          "Không cho phép chạy nhiều lệnh nối tiếp, command substitution, xuống dòng hoặc cd trong shell_run. Hãy dùng tham số cwd của tool.",
      };
    }
  }

  for (const pattern of config.tools.denyPatterns) {
    if (matchesRegex(trimmed, pattern)) {
      return { decision: "deny", reason: `Lệnh khớp mẫu bị cấm: ${pattern}` };
    }
  }

  if (REDIRECTION.test(trimmed)) {
    return {
      decision: "ask",
      reason: "Lệnh có chuyển hướng output/input; cần phê duyệt để tránh ghi đè file ngoài ý muốn.",
    };
  }

  for (const pattern of config.tools.approvalPatterns) {
    if (matchesRegex(trimmed, pattern)) {
      return { decision: "ask", reason: `Lệnh có thể thay đổi trạng thái repo/hệ thống: ${pattern}` };
    }
  }

  const firstToken = trimmed.split(/\s+/)[0] ?? "";
  if (firstToken.includes("=")) {
    return { decision: "deny", reason: "Không cho phép gán biến môi trường trước lệnh." };
  }
  const executable = executableName(firstToken);
  if (!config.tools.shellAllowlist.map((item) => item.toLowerCase()).includes(executable)) {
    return {
      decision: "ask",
      reason: `Lệnh "${executable}" không nằm trong allowlist; cần phê duyệt thủ công.`,
    };
  }

  if (executable === "git") {
    const gitDecision = classifyGit(trimmed);
    if (gitDecision) return gitDecision;
  }

  return { decision: "allow", reason: "Lệnh nằm trong allowlist và không khớp mẫu nguy hiểm." };
}

function classifyGit(command: string): PolicyResult | null {
  const parts = command.split(/\s+/);
  const sub = (parts[1] ?? "").toLowerCase();
  if (!sub) return { decision: "allow", reason: "git không có subcommand." };
  if (["push", "reset", "clean", "rebase", "filter-branch", "update-ref"].includes(sub)) {
    return { decision: "deny", reason: `git ${sub} bị cấm trong môi trường agent.` };
  }
  if (["add", "commit", "checkout", "switch", "merge", "stash", "restore", "rm", "mv", "tag"].includes(sub)) {
    return { decision: "ask", reason: `git ${sub} thay đổi trạng thái repo; cần phê duyệt.` };
  }
  return null;
}

export function classifyPath(options: {
  workspace: string;
  target: string;
  operation: "read" | "write";
  config: AgentConfig;
}): PolicyResult {
  const absolute = path.isAbsolute(options.target)
    ? path.resolve(options.target)
    : path.resolve(options.workspace, options.target);
  const root = path.resolve(options.workspace);

  if (!isSubPath(root, absolute)) {
    return { decision: "deny", reason: `Đường dẫn nằm ngoài workspace: ${absolute}` };
  }
  const relative = normalizeRelative(path.relative(root, absolute));
  const posix = toPosix(relative);
  const segments = posix.split("/");
  if (segments.includes(".git")) {
    return { decision: "deny", reason: "Không được đọc/ghi thư mục .git." };
  }
  if (matchesAnyGlob(posix, options.config.workspace.protectedPaths)) {
    return {
      decision: "deny",
      reason: `Đường dẫn được bảo vệ (secret/config/hệ thống): ${posix}`,
    };
  }

  const allowed = options.config.workspace.allowedRoots.some(
    (entry) => entry === "." || posix === entry || posix.startsWith(`${toPosix(entry)}/`),
  );
  if (!allowed) {
    return {
      decision: "ask",
      reason: `Đường dẫn ngoài allowedRoots: ${posix}`,
    };
  }

  return { decision: "allow", reason: `${options.operation} ${posix} được phép.` };
}

function executableName(token: string): string {
  const cleaned = token.replace(/^["']|["']$/g, "");
  const base = cleaned.split(/[\\/]/).pop() ?? cleaned;
  return base.toLowerCase();
}

function matchesRegex(value: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, "i").test(value);
  } catch {
    return false;
  }
}

export function isProtectedPath(workspace: string, relative: string, config: AgentConfig): boolean {
  const absolute = path.resolve(workspace, relative);
  return classifyPath({ workspace, target: absolute, operation: "write", config }).decision === "deny";
}
