import { spawn, spawnSync } from "node:child_process";
import { tail } from "../util/text.js";

export interface ExecResult {
  command: string;
  cwd: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ExecOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputChars?: number;
  env?: Record<string, string>;
}

export function execShell(options: ExecOptions): Promise<ExecResult> {
  const started = Date.now();
  const maxOutput = options.maxOutputChars ?? 2_000_000;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let settled = false;

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.command, {
        cwd: options.cwd,
        shell: true,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: "1", ...options.env },
      });
    } catch (error) {
      resolve({
        command: options.command,
        cwd: options.cwd,
        ok: false,
        exitCode: null,
        timedOut: false,
        stdout: "",
        stderr: (error as Error).message,
        durationMs: Date.now() - started,
      });
      return;
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > maxOutput) stdout = stdout.slice(stdout.length - maxOutput);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > maxOutput) stderr = stderr.slice(stderr.length - maxOutput);
    });

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        command: options.command,
        cwd: options.cwd,
        ok: exitCode === 0 && !timedOut,
        exitCode,
        timedOut,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    };

    child.on("error", (error) => {
      stderr += `\n${error.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    setTimeout(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Đã chết.
      }
    }, 2000);
  } catch {
    // Đã chết.
  }
}

export function formatExecResult(result: ExecResult, maxChars = 12_000): string {
  const parts = [
    `$ ${result.command}`,
    `cwd: ${result.cwd}`,
    `exit: ${result.exitCode ?? "null"}${result.timedOut ? " (TIMEOUT)" : ""} · ${result.durationMs}ms`,
  ];
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n--- stderr ---\n");
  if (output) parts.push(tail(output, maxChars));
  else parts.push("(không có output)");
  return parts.join("\n");
}
