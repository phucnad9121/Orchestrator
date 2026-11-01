import path from "node:path";
import { classifyPath, classifyShell } from "../core/policy.js";
import type { TestRunRecord } from "../types.js";
import { PolicyDeniedError } from "../util/errors.js";
import { pathExists, toPosix } from "../util/fsx.js";
import { quoteForShell, stableHash, tail, truncate } from "../util/text.js";
import { execShell, formatExecResult } from "./exec.js";
import {
  optionalNumber,
  optionalString,
  type ToolContext,
  type ToolDefinition,
  type ToolOutput,
} from "./types.js";

export const testTools: ToolDefinition[] = [
  {
    name: "test_run",
    description:
      "Chạy bộ kiểm thử đã cấu hình (backend/frontend/all). Trả về PASS/FAIL, exit code và phần cuối output. Bắt buộc dùng trước khi báo hoàn thành task testing.",
    parameters: {
      type: "object",
      properties: {
        suite: {
          type: "string",
          description: "Tên suite trong config (backend, frontend, all...). Mặc định 'all'.",
        },
        extraArgs: { type: "string", description: "Tham số thêm (tuỳ chọn)." },
        timeoutMs: { type: "integer", description: "Timeout riêng (ms)." },
      },
      required: [],
    },
    async execute(args, context) {
      return runTests(args, context);
    },
  },
];

interface SuiteExecution {
  suite: string;
  record: TestRunRecord;
  output: string;
  durationMs: number;
}

async function runTests(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput> {
  const requested = (optionalString(args, "suite") ?? "all").trim();
  const suites = requested === "all" ? Object.keys(context.config.tests) : [requested];
  if (suites.length === 0) {
    return {
      ok: false,
      output: "Chưa cấu hình bộ test nào trong agent.config.json (tests).",
    };
  }
  for (const suite of suites) {
    if (!context.config.tests[suite]) {
      return {
        ok: false,
        output: `Suite "${suite}" không tồn tại. Có: ${Object.keys(context.config.tests).join(", ")}`,
      };
    }
  }

  const extraArgs = optionalString(args, "extraArgs") ?? "";
  const requestedTimeout = optionalNumber(args, "timeoutMs");
  const executions: SuiteExecution[] = [];

  for (const suite of suites) {
    const execution = await runOneSuite(suite, extraArgs, requestedTimeout, context);
    executions.push(execution);
    if (!execution.record.passed && suite !== suites[suites.length - 1]) {
      // Vẫn chạy các suite còn lại để có bức tranh đầy đủ.
    }
  }

  const allPassed = executions.every((execution) => execution.record.passed);
  return {
    ok: allPassed,
    output: executions.map((execution) => execution.output).join("\n\n"),
    meta: { testsRun: executions.map((execution) => execution.record) },
  };
}

async function runOneSuite(
  suite: string,
  extraArgs: string,
  requestedTimeout: number | undefined,
  context: ToolContext,
): Promise<SuiteExecution> {
  const config = context.config.tests[suite];
  if (!config) throw new Error(`Thiếu cấu hình test suite "${suite}".`);
  const cwdInput = config.cwd || ".";
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

  const command = `${resolvePlaceholders(config.command, context.workspace)}${
    extraArgs ? ` ${extraArgs}` : ""
  }`.trim();
  const timeoutMs = Math.max(
    1000,
    Math.min(
      requestedTimeout ?? config.timeoutMs ?? 600_000,
      context.config.limits.taskTimeoutMs,
    ),
  );

  if (!pathExists(absoluteCwd)) {
    const record: TestRunRecord = {
      suite,
      command,
      cwd: toPosix(cwdInput),
      passed: false,
      outputTail: `Thư mục không tồn tại: ${toPosix(cwdInput)}`,
    };
    return {
      suite,
      record,
      output: `### ${suite.toUpperCase()} — FAIL\n${record.outputTail}`,
      durationMs: 0,
    };
  }

  const policy = classifyShell(command, context.config);
  await context.approvals.authorize({
    taskId: context.task.id,
    role: context.role,
    tool: "test_run",
    argsHash: stableHash({ suite, command, cwd: toPosix(cwdInput) }),
    summary: `Chạy test suite "${suite}": ${truncate(command, 200)}`,
    detail: `cwd=${toPosix(cwdInput)}\nsuite=${suite}`,
    policy,
  });

  const result = await execShell({
    command,
    cwd: absoluteCwd,
    timeoutMs,
    maxOutputChars: 2_000_000,
  });
  const outputTail = tail(
    [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n--- stderr ---\n"),
    4000,
  );
  const record: TestRunRecord = {
    suite,
    command,
    cwd: toPosix(cwdInput),
    passed: result.ok,
    exitCode: result.exitCode ?? undefined,
    outputTail,
  };
  return {
    suite,
    record,
    output: [
      `### ${suite.toUpperCase()} — ${record.passed ? "PASS" : "FAIL"} (exit ${
        record.exitCode ?? "null"
      }, ${result.durationMs}ms)`,
      formatExecResult(result, context.config.limits.maxToolOutputChars),
    ].join("\n"),
    durationMs: result.durationMs,
  };
}

export function resolvePlaceholders(command: string, workspace: string): string {
  const isWindows = process.platform === "win32";
  const wrapper = path.join(workspace, "backend", isWindows ? "mvnw.cmd" : "mvnw");
  const mvnw = pathExists(wrapper) ? quoteForShell(wrapper) : "mvn";
  return command
    .replace(/\{mvnw\}/g, mvnw)
    .replace(/\{npm\}/g, "npm")
    .replace(/\{workspace\}/g, quoteForShell(workspace));
}
