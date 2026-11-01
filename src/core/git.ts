import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { GitInfo } from "../types.js";
import { tail } from "../util/text.js";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function runGit(workspace: string, args: string[], timeout = 30_000): GitResult {
  try {
    const execFileSyncOptions = {
      cwd: workspace,
      encoding: "utf8" as const,
      timeout,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
    };
    const stdout = execFileSync("git", args, execFileSyncOptions);
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    const failure = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      ok: false,
      stdout: failure.stdout ? failure.stdout.toString() : "",
      stderr: failure.stderr ? failure.stderr.toString() : failure.message,
    };
  }
}

export function getGitInfo(workspace: string): GitInfo {
  const inside = runGit(workspace, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return { isRepo: false, dirtyAtStart: false, status: "" };
  }
  const branch = runGit(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  const commit = runGit(workspace, ["rev-parse", "--short", "HEAD"]).stdout.trim();
  const status = runGit(workspace, ["status", "--porcelain=v1", "-uall"]).stdout;
  return {
    isRepo: true,
    branch: branch || undefined,
    commit: commit || undefined,
    dirtyAtStart: status.trim().length > 0,
    status: status.trim(),
  };
}

export function gitStatusText(workspace: string): string {
  const result = runGit(workspace, ["status", "--porcelain=v1", "-uall"]);
  return result.ok ? result.stdout.trim() : `(không đọc được git status: ${result.stderr.trim()})`;
}

export function parseStatusPaths(statusText: string): string[] {
  const paths: string[] = [];
  for (const line of statusText.split(/\r?\n/)) {
    if (line.trim().length < 4) continue;
    let value = line.slice(3).trim();
    const rename = value.split(" -> ");
    if (rename.length > 1) value = rename[rename.length - 1] ?? value;
    value = unquote(value);
    if (value) paths.push(value);
  }
  return [...new Set(paths)];
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t");
  }
  return value;
}

export interface WorkspaceSnapshot {
  hashes: Map<string, string>;
  statusText: string;
  at: string;
}

/** Chụp nhanh các file đang thay đổi (kể cả untracked) để quy trách nhiệm theo task. */
export function snapshotWorkspace(workspace: string): WorkspaceSnapshot {
  const statusText = gitStatusText(workspace);
  const hashes = new Map<string, string>();
  for (const relative of parseStatusPaths(statusText)) {
    const absolute = path.join(workspace, relative);
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) continue;
      const size = Math.min(stat.size, 2 * 1024 * 1024);
      const buffer = Buffer.alloc(size);
      const fd = fs.openSync(absolute, "r");
      try {
        fs.readSync(fd, buffer, 0, size, 0);
      } finally {
        fs.closeSync(fd);
      }
      const hash = createHash("sha1")
        .update(String(stat.size))
        .update(":")
        .update(buffer)
        .digest("hex");
      hashes.set(relative.split(path.sep).join("/"), hash);
    } catch {
      hashes.set(relative.split(path.sep).join("/"), "DELETED");
    }
  }
  return { hashes, statusText, at: new Date().toISOString() };
}

export function diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
  const paths = new Set([...before.hashes.keys(), ...after.hashes.keys()]);
  const changed: string[] = [];
  for (const relative of paths) {
    if (before.hashes.get(relative) !== after.hashes.get(relative)) changed.push(relative);
  }
  return changed.sort((a, b) => a.localeCompare(b));
}

export function diffStat(workspace: string): string {
  const tracked = runGit(workspace, ["diff", "--stat"]);
  const staged = runGit(workspace, ["diff", "--cached", "--stat"]);
  const status = gitStatusText(workspace);
  return [tracked.stdout.trim(), staged.stdout.trim(), status ? `\nUntracked/chưa stage:\n${status}` : ""]
    .filter(Boolean)
    .join("\n");
}

export function diffPatch(workspace: string, maxChars = 60_000): string {
  const tracked = runGit(workspace, ["diff", "--no-color"]);
  const staged = runGit(workspace, ["diff", "--cached", "--no-color"]);
  const combined = [tracked.stdout, staged.stdout].filter(Boolean).join("\n");
  return tail(combined || "(không có diff của file đã track)", maxChars);
}

export function recentCommits(workspace: string, count = 5): string[] {
  const result = runGit(workspace, ["log", `-${count}`, "--pretty=format:%h %s"]);
  if (!result.ok) return [];
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

/** Kiểm tra một lệnh có sẵn trên máy (dùng cho doctor). */
export function commandExists(command: string): boolean {
  const isWindows = process.platform === "win32";
  const result = spawnSync(isWindows ? "where" : "which", [command], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 && result.stdout.trim().length > 0;
}
