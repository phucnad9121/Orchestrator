import fs from "node:fs";
import path from "node:path";
import type {
  AgentConfig,
  AgentRole,
  Issue,
  TaskResult,
  TaskState,
  TestRunRecord,
} from "../types.js";
import type { LLM, LLMUsage } from "../llm/types.js";
import type { MessageBus } from "../core/bus.js";
import type { ApprovalManager } from "../core/approvals.js";
import type { ToolRegistry } from "../tools/registry.js";
import { gitStatusText } from "../core/git.js";
import { ApprovalRequiredError, PolicyDeniedError } from "../util/errors.js";
import type { EventLogger } from "../util/logger.js";
import {
  extractJsonObject,
  nowIso,
  redactSecrets,
  stableHash,
  truncate,
} from "../util/text.js";
import { systemPromptFor } from "./prompts.js";
import type { ChatMessage, ToolCall } from "../llm/types.js";

const SEVERITIES = new Set(["critical", "high", "medium", "low"]);

export interface AgentOptions {
  role: AgentRole;
  llm: LLM;
  config: AgentConfig;
  tools: ToolRegistry;
  bus: MessageBus;
  approvals: ApprovalManager;
  logger: EventLogger;
  workspace: string;
  runDir: string;
  repoProfile: string;
  onUsage: (usage: LLMUsage) => void;
}

export interface AgentTaskInput {
  task: TaskState;
  tasks: TaskState[];
  attempt: number;
  feedback?: string;
}

export class BaseAgent {
  constructor(private readonly options: AgentOptions) {}

  async runTask(input: AgentTaskInput): Promise<TaskResult> {
    const { task, tasks } = input;
    const started = Date.now();
    const transcript = path.join(this.options.runDir, "transcripts", `${task.id}.jsonl`);
    task.transcriptPath = path.relative(this.options.runDir, transcript).split(path.sep).join("/");
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    this.appendTranscript(transcript, { kind: "task_start", task, attempt: input.attempt });

    const system = systemPromptFor(
      this.options.role,
      this.options.tools.describeForPrompt(),
      this.options.repoProfile,
    );
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: this.buildTaskPrompt(input) },
    ];
    this.appendTranscript(transcript, { kind: "messages", messages });

    const collectedFiles = new Set<string>();
    const collectedTests: TestRunRecord[] = [];
    const deadline = started + this.options.config.limits.taskTimeoutMs;
    const toolSchemas = this.options.tools.schemas();
    let lastContent: string | null = null;

    for (let step = 1; step <= this.options.config.limits.maxStepsPerTask; step += 1) {
      if (Date.now() > deadline) {
        const result = this.failedResult(
          `Timeout task sau ${Math.round(this.options.config.limits.taskTimeoutMs / 1000)}s.`,
          collectedFiles,
          collectedTests,
        );
        this.appendTranscript(transcript, { kind: "result", result });
        return result;
      }

      const remaining = Math.max(1000, deadline - Date.now());
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      let response;
      try {
        this.options.logger.debug("agent.step", `[${this.options.role}] ${task.id} · bước ${step}`);
        response = await this.options.llm.chat({
          messages,
          tools: toolSchemas,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      this.options.onUsage(response.usage);

      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: response.message.content,
        ...(response.message.tool_calls ? { tool_calls: response.message.tool_calls } : {}),
      };
      messages.push(assistantMessage);
      lastContent = response.message.content ?? lastContent;
      this.appendTranscript(transcript, {
        kind: "assistant",
        step,
        content: response.message.content,
        toolCalls: response.message.tool_calls?.map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: truncate(call.function.arguments, 1200),
        })),
        usage: response.usage,
        finishReason: response.finishReason,
      });

      if (response.message.tool_calls && response.message.tool_calls.length > 0) {
        for (const call of response.message.tool_calls) {
          const toolOutput = await this.executeToolCall({
            call,
            task,
            transcript,
            collectedFiles,
            collectedTests,
          });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: toolOutput,
          });
        }
        continue;
      }

      if (!response.message.content?.trim()) {
        const message =
          "Lượt trả lời trước bị rỗng và không có tool call. Hãy tiếp tục task ngay: gọi tool cần thiết hoặc trả JSON kết quả theo contract; không kết thúc bằng phản hồi rỗng.";
        if (step < this.options.config.limits.maxStepsPerTask) {
          this.options.logger.warn(
            "agent.empty_response",
            `[${this.options.role}] ${task.id}: OpenCode trả lượt rỗng; yêu cầu model tiếp tục.`,
          );
          messages.push({ role: "user", content: message });
          continue;
        }
        const result = this.failedResult(
          "Agent tiếp tục trả phản hồi rỗng sau lần yêu cầu khôi phục.",
          collectedFiles,
          collectedTests,
          "Provider trả content rỗng và không có tool_calls ở bước cuối cùng.",
        );
        this.appendTranscript(transcript, {
          kind: "result",
          result,
          durationMs: Date.now() - started,
        });
        return result;
      }

      const result = this.parseResult(response.message.content, collectedFiles, collectedTests);
      const artifactDir = path.join(this.options.runDir, "artifacts");
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.writeFileSync(
        path.join(artifactDir, `${task.id}-result.json`),
        `${JSON.stringify(result, null, 2)}\n`,
      );
      this.appendTranscript(transcript, {
        kind: "result",
        result,
        durationMs: Date.now() - started,
      });
      this.options.logger.success(
        "agent.done",
        `[${this.options.role}] ${task.id} → ${result.status}: ${truncate(result.summary, 160)}`,
      );
      return result;
    }

    const result = this.failedResult(
      `Vượt quá ${this.options.config.limits.maxStepsPerTask} bước mà chưa hoàn thành.`,
      collectedFiles,
      collectedTests,
      lastContent ?? undefined,
    );
    this.appendTranscript(transcript, { kind: "result", result });
    return result;
  }

  private async executeToolCall(options: {
    call: ToolCall;
    task: TaskState;
    transcript: string;
    collectedFiles: Set<string>;
    collectedTests: TestRunRecord[];
  }): Promise<string> {
    const { call, task, transcript, collectedFiles, collectedTests } = options;
    const name = call.function.name;
    this.options.logger.info(
      "agent.tool",
      `[${this.options.role}] ${task.id} → ${name}(${summarizeArguments(call.function.arguments)})`,
    );

    let output;
    try {
      output = await this.options.tools.execute(name, call.function.arguments, {
        workspace: this.options.workspace,
        config: this.options.config,
        runId: path.basename(this.options.runDir),
        runDir: this.options.runDir,
        task,
        role: this.options.role,
        logger: this.options.logger,
        approvals: this.options.approvals,
        bus: this.options.bus,
      });
    } catch (error) {
      if (error instanceof ApprovalRequiredError) {
        this.appendTranscript(transcript, {
          kind: "approval_required",
          tool: name,
          approvalId: error.approval.id,
          summary: error.approval.summary,
        });
        throw error;
      }
      if (error instanceof PolicyDeniedError) {
        output = { ok: false, output: `BỊ CHẶN BỞI POLICY: ${error.message}` };
      } else {
        throw error;
      }
    }

    for (const file of output.meta?.filesChanged ?? []) collectedFiles.add(file);
    for (const test of output.meta?.testsRun ?? []) collectedTests.push(test);

    const content = truncate(
      output.output,
      this.options.config.limits.maxToolOutputChars,
      "\n… [output tool đã cắt bớt]",
    );
    this.appendTranscript(transcript, {
      kind: "tool",
      name,
      callId: call.id,
      ok: output.ok,
      content: truncate(content, 8000),
    });
    return output.ok ? content : `LỖI TOOL: ${content}`;
  }

  private buildTaskPrompt(input: AgentTaskInput): string {
    const { task, tasks, attempt } = input;
    const byId = new Map(tasks.map((item) => [item.id, item]));
    const dependencies = task.dependsOn
      .map((id) => byId.get(id))
      .filter((item): item is TaskState => Boolean(item))
      .map((dependency) => {
        const result = dependency.result;
        const issues = result?.issues?.length
          ? `\nIssues:\n${result.issues
              .slice(0, 10)
              .map((issue) => `- [${issue.severity}] ${issue.title}: ${truncate(issue.detail, 300)}`)
              .join("\n")}`
          : "";
        return [
          `### ${dependency.id} · ${dependency.title} (${dependency.role}) — ${dependency.status}`,
          result ? truncate(result.summary, 1200) : dependency.error ?? "(chưa có kết quả)",
          result?.filesChanged?.length ? `Files: ${result.filesChanged.slice(0, 30).join(", ")}` : "",
          issues,
        ]
          .filter(Boolean)
          .join("\n");
      });

    const inbox = this.options.bus.inbox(this.options.role, task.id);
    if (inbox.length > 0) this.options.bus.markRead(inbox.map((message) => message.id), task.id);
    const messages = inbox.map(
      (message) =>
        `- Từ ${message.from} (${message.createdAt}): ${message.subject}\n${truncate(message.body, 1200)}`,
    );

    const feedback = input.feedback ? `\n## PHẢN HỒI/LỖI TỪ LẦN TRƯỚC\n${truncate(input.feedback, 3000)}` : "";

    return [
      "## TASK ĐƯỢC GIAO",
      "```json",
      JSON.stringify(
        {
          id: task.id,
          title: task.title,
          role: task.role,
          description: task.description,
          acceptance: task.acceptance,
          dependsOn: task.dependsOn,
          filesHint: task.filesHint ?? [],
          round: task.testRound ?? null,
        },
        null,
        2,
      ),
      "```",
      "",
      `## RUN\n- Run ID: ${path.basename(this.options.runDir)}\n- Workspace: ${this.options.workspace}\n- Lần thử: ${attempt}`,
      "",
      "## KẾT QUẢ CÁC TASK PHỤ THUỘC",
      dependencies.length > 0 ? dependencies.join("\n\n") : "(không có)",
      "",
      "## TIN NHẮN TỪ ĐỒNG ĐỘI",
      messages.length > 0 ? messages.join("\n") : "(không có)",
      feedback,
      "",
      "## GIT STATUS HIỆN TẠI",
      truncate(gitStatusText(this.options.workspace) || "(working tree sạch)", 3000),
      "",
      "Hãy thực hiện task này. Đọc code liên quan trước, thay đổi tối thiểu, chạy kiểm tra, rồi trả JSON kết quả đúng contract.",
    ]
      .filter((line) => line !== "")
      .join("\n");
  }

  private parseResult(
    content: string | null,
    collectedFiles: Set<string>,
    collectedTests: TestRunRecord[],
  ): TaskResult {
    if (!content || !content.trim()) {
      return this.failedResult("Agent không trả về nội dung kết quả.", collectedFiles, collectedTests);
    }
    const parsed = extractJsonObject(content) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        status: "done",
        summary: truncate(content.trim(), 1500),
        filesChanged: [...collectedFiles],
        testsRun: dedupeTests(collectedTests),
        issues: [
          {
            severity: "low",
            title: "Agent không trả JSON đúng contract",
            detail:
              "Kết quả cuối không phải JSON hợp lệ nên orchestrator chỉ ghi nhận phần tóm tắt. Cần kiểm tra lại chất lượng task.",
          },
        ],
        nextSteps: [],
        notes: "parseWarning: final answer was not valid JSON.",
        parseWarning: "Final answer không phải JSON hợp lệ.",
      };
    }

    const statusValue = String(parsed.status ?? "done").toLowerCase();
    const status: TaskResult["status"] =
      statusValue === "done" || statusValue === "blocked" || statusValue === "failed"
        ? statusValue
        : "blocked";

    const files = new Set<string>(collectedFiles);
    for (const item of arrayOfStrings(parsed.filesChanged)) files.add(item);
    // Only tool execution metadata is evidence. The model's JSON is untrusted and
    // must never be allowed to manufacture a passing test record.
    const tests = dedupeTests(collectedTests);
    const issues = normalizeIssues(parsed.issues);
    const claimedTests = normalizeTests(parsed.testsRun);
    if (claimedTests.length > 0 && collectedTests.length === 0) {
      issues.push({
        severity: "low",
        title: "Bỏ qua kết quả test do agent tự khai",
        detail: "Không có test_run tương ứng trong log công cụ; testsRun chỉ ghi nhận kết quả được thực thi bởi orchestrator.",
      });
    }
    const summary = String(parsed.summary ?? "").trim() || truncate(content, 500);
    const notes = parsed.notes === undefined ? undefined : String(parsed.notes);

    return {
      status,
      summary,
      filesChanged: [...files].sort(),
      testsRun: tests,
      issues,
      nextSteps: arrayOfStrings(parsed.nextSteps),
      ...(notes ? { notes } : {}),
    };
  }

  private failedResult(
    summary: string,
    files: Set<string>,
    tests: TestRunRecord[],
    detail?: string,
  ): TaskResult {
    return {
      status: "failed",
      summary,
      filesChanged: [...files],
      testsRun: dedupeTests(tests),
      issues: [
        {
          severity: "high",
          title: summary,
          detail: detail ? truncate(detail, 2000) : summary,
        },
      ],
      nextSteps: ["Kiểm tra log/transcript của task và thử lại."],
    };
  }

  private appendTranscript(file: string, record: unknown): void {
    const payload = {
      ts: nowIso(),
      ...(record as Record<string, unknown>),
    };
    const text = redactSecrets(JSON.stringify(payload));
    fs.appendFileSync(file, `${text}\n`);
  }
}

function summarizeArguments(raw: string): string {
  if (!raw || raw === "{}") return "";
  const compact = raw.replace(/\s+/g, " ");
  return truncate(compact, 140);
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter((item) => item.trim().length > 0);
}

function normalizeTests(value: unknown): TestRunRecord[] {
  if (!Array.isArray(value)) return [];
  const tests: TestRunRecord[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    tests.push({
      suite: String(record.suite ?? "unknown"),
      command: String(record.command ?? ""),
      cwd: record.cwd === undefined ? undefined : String(record.cwd),
      passed: record.passed === true,
      exitCode: Number.isFinite(Number(record.exitCode)) ? Number(record.exitCode) : undefined,
      outputTail:
        record.outputTail === undefined ? undefined : truncate(String(record.outputTail), 2000),
    });
  }
  return tests;
}

function dedupeTests(tests: TestRunRecord[]): TestRunRecord[] {
  const seen = new Set<string>();
  const result: TestRunRecord[] = [];
  for (const test of tests) {
    const key = stableHash({ suite: test.suite, command: test.command, passed: test.passed });
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(test);
  }
  return result;
}

function normalizeIssues(value: unknown): Issue[] {
  if (!Array.isArray(value)) return [];
  const issues: Issue[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const issue = item as Record<string, unknown>;
    const severity = String(issue.severity ?? "medium").toLowerCase();
    const title = String(issue.title ?? "").trim();
    if (!title) continue;
    issues.push({
      severity: (SEVERITIES.has(severity) ? severity : "medium") as Issue["severity"],
      title: truncate(title, 200),
      detail: truncate(String(issue.detail ?? ""), 2000),
      ...(issue.file ? { file: String(issue.file) } : {}),
      ...(Number.isFinite(Number(issue.line)) ? { line: Number(issue.line) } : {}),
      ...(issue.repro ? { repro: truncate(String(issue.repro), 1200) } : {}),
      ...(issue.suspectedCause ? { suspectedCause: truncate(String(issue.suspectedCause), 1200) } : {}),
    });
  }
  return issues;
}

/** Tạo agent theo vai trò. */
export function createAgent(role: AgentRole, options: Omit<AgentOptions, "role">): BaseAgent {
  return new BaseAgent({ ...options, role });
}
