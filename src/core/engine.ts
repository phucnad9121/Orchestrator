import fs from "node:fs";
import path from "node:path";
import type {
  AgentConfig,
  AgentRole,
  Issue,
  RunState,
  TaskResult,
  TaskState,
} from "../types.js";
import type { LLM, LLMUsage } from "../llm/types.js";
import type { EventLogger } from "../util/logger.js";
import { ApprovalManager } from "./approvals.js";
import { MessageBus } from "./bus.js";
import { buildRepoProfile } from "./context.js";
import { diffSnapshots, snapshotWorkspace } from "./git.js";
import {
  createEngineTask,
  createTaskStates,
  recomputeReady,
  renderTasksMarkdown,
  selectReadyTasks,
} from "./plan.js";
import { Planner } from "../agents/planner.js";
import { createAgent } from "../agents/base.js";
import type { BaseAgent } from "../agents/base.js";
import { createDefaultRegistry } from "../tools/registry.js";
import { ApprovalRequiredError, errorMessage } from "../util/errors.js";
import { toPosix } from "../util/fsx.js";
import { nowIso, truncate } from "../util/text.js";
import { saveRun } from "./state.js";
import { writeReport } from "./reporter.js";

export interface EngineOptions {
  state: RunState;
  runDir: string;
  workspace: string;
  config: AgentConfig;
  llm: LLM;
  logger: EventLogger;
  autoApprove: boolean;
  interactive: boolean;
}

export class Engine {
  private readonly state: RunState;
  private readonly runDir: string;
  private readonly workspace: string;
  private readonly config: AgentConfig;
  private readonly llm: LLM;
  private readonly logger: EventLogger;
  private readonly tools = createDefaultRegistry();
  private readonly bus: MessageBus;
  private readonly approvals: ApprovalManager;
  private readonly repoProfile: string;
  private readonly planner: Planner;
  private readonly agents = new Map<AgentRole, BaseAgent>();
  private readonly autoApprove: boolean;
  private readonly interactive: boolean;
  private paused = false;

  constructor(options: EngineOptions) {
    this.state = options.state;
    this.runDir = options.runDir;
    this.workspace = options.workspace;
    this.config = options.config;
    this.llm = options.llm;
    this.logger = options.logger.child(options.runDir);
    this.autoApprove = options.autoApprove;
    this.interactive = options.interactive;
    this.bus = new MessageBus(this.runDir, (message) => {
      this.logger.info("team.message", `${message.from} → ${message.to} · ${message.subject}`, {
        messageId: message.id,
        taskId: message.taskId,
      });
    });
    this.approvals = new ApprovalManager({
      state: this.state,
      config: this.config,
      logger: this.logger,
      autoApprove: this.autoApprove,
      interactive: this.interactive,
      save: () => this.save(),
    });
    this.repoProfile = buildRepoProfile(this.workspace, this.config);
    this.state.quality.maxCycles = this.config.limits.maxFixCycles;
    this.planner = new Planner({
      llm: options.llm,
      config: this.config,
      logger: this.logger,
      repoProfile: this.repoProfile,
      onUsage: (usage) => this.addUsage(usage),
    });
  }

  async startNew(request: string, planOnly: boolean): Promise<RunState> {
    this.state.status = "planning";
    this.state.phase = "planning";
    this.state.startedAt = nowIso();
    this.save();
    this.logger.info("run.start", `Bắt đầu run ${this.state.id} · ${this.config.provider.model}`);
    this.logger.info("run.request", truncate(request.replace(/\r?\n/g, " "), 300));

    try {
      const plan = await this.planner.createPlan(request);
      this.state.plan = plan;
      this.state.tasks = createTaskStates(plan);
      recomputeReady(this.state.tasks);
      this.state.phase = planOnly ? "done" : "implementation";
      this.state.status = planOnly ? "planned" : "running";
      this.save();
      this.writeTasks();
      this.logPlan();

      if (planOnly) {
        this.state.finishedAt = nowIso();
        this.finalizeReport();
        return this.state;
      }

      return await this.executeRemaining();
    } catch (error) {
      return this.failRun(error);
    }
  }

  async resume(): Promise<RunState> {
    this.state.status = "running";
    this.state.error = undefined;
    this.state.finishedAt = undefined;
    this.paused = false;
    for (const task of this.state.tasks) {
      if (task.status === "needs_approval") {
        task.status = "ready";
        task.error = undefined;
        delete task.approvalId;
      }
    }
    recomputeReady(this.state.tasks);
    this.save();
    this.logger.info("run.resume", `Tiếp tục run ${this.state.id}`);
    return this.executeRemaining();
  }

  private async executeRemaining(): Promise<RunState> {
    try {
      const implementationPending = this.state.tasks.some(
        (task) => task.generatedBy === "planner" && !isTerminal(task.status),
      );
      if (implementationPending) {
        await this.runImplementation();
        if (this.paused) return this.pauseRun();
      }

      await this.runQualityLoop();
      if (this.paused) return this.pauseRun();

      this.state.finishedAt = nowIso();
      this.state.phase = "done";
      this.state.status = this.finalStatus();
      this.finalizeReport();
      return this.state;
    } catch (error) {
      return this.failRun(error);
    }
  }

  private async runImplementation(): Promise<void> {
    this.state.phase = "implementation";
    this.state.status = "running";
    this.save();
    this.logger.info("phase.implementation", "Bắt đầu giai đoạn implementation");

    let guard = 0;
    const maxParallel = Number.isFinite(this.config.limits.maxParallel)
      ? Math.max(1, Math.floor(this.config.limits.maxParallel))
      : 1;
    while (!this.paused) {
      guard += 1;
      if (guard > 500) {
        throw new Error("Scheduler vượt quá 500 vòng lặp — kiểm tra dependency/lifecycle.");
      }
      recomputeReady(this.state.tasks);
      const batch = selectReadyTasks(this.state.tasks, maxParallel);
      if (batch.length > 0) {
        if (batch.length > 1) {
          this.logger.info(
            "phase.implementation.parallel",
            `Chạy song song ${batch.length} task (giới hạn ${maxParallel}): ${batch
              .map((task) => `${task.id}[${task.role}]`)
              .join(", ")}`,
          );
        }
        await Promise.all(
          batch.map((task) => this.runTaskWithRetries(task, batch.length === 1)),
        );

        // Task đang chạy dở khi một task khác yêu cầu approval phải quay về
        // ready để resume có thể chạy lại, tránh kẹt ở in_progress.
        if (this.paused) {
          for (const task of batch) {
            if (task.status === "in_progress") {
              task.status = "ready";
              task.error = "Tạm dừng do task khác cần phê duyệt; sẽ chạy lại khi resume.";
            }
          }
        }
        this.save();
        this.writeTasks();
        continue;
      }

      const needsApproval = this.state.tasks.find((item) => item.status === "needs_approval");
      if (needsApproval) {
        this.paused = true;
        this.state.status = "awaiting_approval";
        break;
      }

      const pending = this.state.tasks.filter((item) => item.status === "pending");
      if (pending.length > 0) {
        // Không còn task ready nhưng vẫn pending: dependency bị kẹt.
        for (const item of pending) {
          item.status = "skipped";
          item.blockedBy = item.dependsOn;
          item.error = "Không thể chạy vì dependency không hoàn thành.";
        }
        this.save();
        continue;
      }
      break;
    }
    this.writeTasks();
    if (!this.paused) {
      const failed = this.state.tasks.filter(
        (task) => task.generatedBy === "planner" && task.status !== "done",
      );
      this.logger.info(
        "phase.implementation.done",
        `Implementation xong · ${this.state.tasks.filter((task) => task.status === "done").length}/${
          this.state.tasks.filter((task) => task.generatedBy === "planner").length
        } task đạt${failed.length > 0 ? ` · ${failed.length} task chưa đạt` : ""}`,
      );
    }
  }

  private async runTaskWithRetries(task: TaskState, trackWorkspaceDiff = true): Promise<void> {
    const maxAttempts = Math.max(1, this.config.limits.maxTaskAttempts);
    // Khi chạy song song, snapshot git là toàn workspace nên không thể quy
    // trách nhiệm chính xác cho từng task. Dùng filesChanged do tool/agent báo
    // cáo; report vẫn có git status/diff tổng ở cuối run.
    while (task.attempts < maxAttempts) {
      task.attempts += 1;
      task.status = "in_progress";
      task.startedAt = task.startedAt ?? nowIso();
      task.finishedAt = undefined;
      delete task.approvalId;
      const feedback = task.error;
      task.error = undefined;
      this.save();

      this.logger.info(
        "task.start",
        `[${task.role}] ${task.id} · ${truncate(task.title, 120)} (lần ${task.attempts}/${maxAttempts})`,
      );
      const started = Date.now();
      const before = trackWorkspaceDiff ? snapshotWorkspace(this.workspace) : undefined;

      try {
        const agent = this.agentFor(task.role);
        const result = await agent.runTask({
          task,
          tasks: this.state.tasks,
          attempt: task.attempts,
          feedback,
        });
        if (before) {
          const after = snapshotWorkspace(this.workspace);
          const actualFiles = diffSnapshots(before, after);
          result.filesChanged = mergeFiles(task.filesChanged, result.filesChanged, actualFiles);
        }

        task.result = result;
        task.filesChanged = result.filesChanged;
        task.finishedAt = nowIso();
        task.status = result.status === "done" ? "done" : result.status;
        task.error =
          result.status === "done"
            ? undefined
            : summarizeResultForFeedback(result, task.attempts, maxAttempts);
        this.save();

        this.logger[result.status === "done" ? "success" : "warn"](
          "task.finish",
          `[${task.role}] ${task.id} → ${task.status} · ${Math.round((Date.now() - started) / 1000)}s · ${truncate(
            result.summary,
            140,
          )}`,
        );

        if (result.status === "done") return;
        if (task.attempts >= maxAttempts || this.paused) return;
        this.logger.warn("task.retry", `Thử lại ${task.id} với phản hồi từ lần trước.`);
      } catch (error) {
        if (before) {
          const after = snapshotWorkspace(this.workspace);
          task.filesChanged = mergeFiles(task.filesChanged, [], diffSnapshots(before, after));
        }
        if (error instanceof ApprovalRequiredError) {
          task.status = "needs_approval";
          task.approvalId = error.approval.id;
          task.error = `Chờ phê duyệt: ${error.approval.summary}`;
          task.finishedAt = nowIso();
          // Lần thử bị tạm dừng không tính là đã dùng hết attempt.
          task.attempts = Math.max(0, task.attempts - 1);
          this.paused = true;
          this.state.status = "awaiting_approval";
          this.save();
          this.logger.warn(
            "task.approval",
            `Tạm dừng ${task.id} để chờ duyệt ${error.approval.id} · ${error.approval.summary}`,
          );
          return;
        }
        task.error = errorMessage(error);
        task.finishedAt = nowIso();
        this.save();
        this.logger.error("task.error", `[${task.role}] ${task.id} lỗi: ${task.error}`);
        if (task.attempts >= maxAttempts) {
          task.status = "failed";
          task.result = {
            status: "failed",
            summary: `Không thể hoàn thành sau ${task.attempts} lần thử: ${task.error}`,
            filesChanged: task.filesChanged,
            testsRun: [],
            issues: [
              {
                severity: "high",
                title: `Task ${task.id} thất bại`,
                detail: task.error,
              },
            ],
            nextSteps: ["Kiểm tra cấu hình LLM/môi trường và chạy lại task."],
          };
          this.save();
          return;
        }
        if (this.paused) return;
        this.logger.warn("task.retry", `Thử lại ${task.id} sau lỗi.`);
      }
    }
  }

  private async runQualityLoop(): Promise<void> {
    const quality = this.state.quality;
    quality.maxCycles = this.config.limits.maxFixCycles;
    if (quality.passed === true) return;
    if (!quality.currentVerifyId && !quality.currentDebugId) {
      const last = quality.history[quality.history.length - 1];
      if (last && !last.passed && quality.cycles >= quality.maxCycles) {
        quality.passed = false;
        return;
      }
    }

    this.state.phase = "verification";
    this.state.status = "running";
    this.save();
    this.logger.info("phase.verification", "Bắt đầu vòng kiểm thử tự động");

    let guard = 0;
    while (!this.paused) {
      guard += 1;
      if (guard > 30) {
        this.logger.warn("quality.guard", "Dừng vòng kiểm thử do vượt 30 vòng lặp.");
        quality.passed = false;
        quality.blockedReason = "Vòng kiểm thử không hội tụ.";
        return;
      }

      if (quality.currentDebugId) {
        const debugTask = this.getTask(quality.currentDebugId);
        if (!debugTask) {
          quality.currentDebugId = undefined;
          continue;
        }
        if (!isTerminal(debugTask.status)) {
          await this.runTaskWithRetries(debugTask);
          if (this.paused) return;
        }
        quality.cycles += 1;
        const verify = this.createVerifyTask(quality.cycles + 1, debugTask.id);
        this.state.tasks.push(verify);
        recomputeReady(this.state.tasks);
        quality.currentVerifyId = verify.id;
        quality.currentDebugId = undefined;
        this.save();
        this.writeTasks();
        continue;
      }

      if (quality.currentVerifyId) {
        const verifyTask = this.getTask(quality.currentVerifyId);
        if (!verifyTask) {
          quality.currentVerifyId = undefined;
          continue;
        }
        if (!isTerminal(verifyTask.status)) {
          await this.runTaskWithRetries(verifyTask);
          if (this.paused) return;
        }
        const evaluation = this.evaluateVerification(verifyTask);
        quality.history.push({
          cycle: verifyTask.testRound ?? quality.cycles + 1,
          verifyTaskId: verifyTask.id,
          debugTaskId: verifyTask.dependsOn.filter((id) => id.startsWith("debug-")).at(-1),
          passed: evaluation.passed,
          issueCount: evaluation.issueCount,
          blockingIssues: evaluation.blocking,
          summary: evaluation.summary,
          at: nowIso(),
        });
        quality.passed = evaluation.passed;
        quality.currentVerifyId = undefined;
        if (evaluation.passed) {
          this.logger.success("quality.pass", `Kiểm thử đạt: ${evaluation.summary}`);
          this.save();
          return;
        }
        if (evaluation.blocked) {
          quality.blockedReason = evaluation.blockedReason;
          quality.passed = false;
          this.logger.warn("quality.blocked", evaluation.blockedReason ?? "Không thể xác minh.");
          this.save();
          return;
        }
        if (quality.cycles >= quality.maxCycles) {
          quality.passed = false;
          this.logger.warn(
            "quality.exhausted",
            `Đã dùng ${quality.cycles}/${quality.maxCycles} vòng sửa lỗi nhưng vẫn chưa đạt.`,
          );
          this.save();
          return;
        }
        const debug = this.createDebugTask(quality.cycles + 1, verifyTask, evaluation.issues);
        this.state.tasks.push(debug);
        recomputeReady(this.state.tasks);
        quality.currentDebugId = debug.id;
        this.save();
        this.writeTasks();
        this.logger.info(
          "quality.debug",
          `Tạo ${debug.id} để xử lý ${evaluation.blocking} issue blocking`,
        );
        continue;
      }

      const verify = this.createVerifyTask(quality.cycles + 1);
      this.state.tasks.push(verify);
      recomputeReady(this.state.tasks);
      quality.currentVerifyId = verify.id;
      this.save();
      this.writeTasks();
    }
  }

  private evaluateVerification(task: TaskState): {
    passed: boolean;
    blocked: boolean;
    blockedReason?: string;
    issueCount: number;
    blocking: number;
    issues: Issue[];
    summary: string;
  } {
    const result = task.result;
    if (!result) {
      return {
        passed: false,
        blocked: true,
        blockedReason: `Task ${task.id} không có kết quả kiểm thử.`,
        issueCount: 0,
        blocking: 1,
        issues: [],
        summary: "Không có kết quả kiểm thử.",
      };
    }

    if (result.status !== "done" && result.status !== "failed") {
      return {
        passed: false,
        blocked: true,
        blockedReason: `Testing Agent trả trạng thái "${result.status}": ${truncate(result.summary, 300)}`,
        issueCount: result.issues.length,
        blocking: result.issues.filter(isBlockingIssue).length,
        issues: result.issues,
        summary: result.summary,
      };
    }

    const issues = [...result.issues];
    const failedTests = result.testsRun.filter((test) => !test.passed);
    const requiredSuites = Object.keys(this.config.tests);
    const executedSuites = new Set(result.testsRun.map((test) => test.suite));
    const missingSuites = requiredSuites.length === 0
      ? ["(chưa cấu hình suite)"]
      : requiredSuites.filter((suite) => !executedSuites.has(suite));
    const noEvidence = this.state.mode !== "mock" && missingSuites.length > 0;
    if (noEvidence) {
      const issue: Issue = {
        severity: "high",
        title: "Không có bằng chứng kiểm thử",
        detail:
          "Testing Agent không chạy test suite nào hoặc không trả testsRun. Cần chạy ít nhất một suite trước khi kết luận.",
        repro: "Gọi tool test_run với suite=all",
      };
      issues.push(issue);
      result.issues.push(issue);
    }
    for (const test of failedTests) {
      const issue: Issue = {
        severity: "high",
        title: `Test suite "${test.suite}" thất bại`,
        detail: truncate(test.outputTail ?? "Không có output.", 1500),
        repro: test.command,
      };
      issues.push(issue);
      result.issues.push(issue);
    }

    const blocking = issues.filter(isBlockingIssue).length;
    const passed = result.status === "done" && blocking === 0;
    const blockedReason = noEvidence
      ? `Testing Agent chưa chạy đủ test suite: ${missingSuites.join(", ")}.`
      : undefined;

    return {
      passed,
      blocked: noEvidence,
      ...(blockedReason ? { blockedReason } : {}),
      issueCount: issues.length,
      blocking,
      issues,
      summary: passed
        ? `Tests/build đạt; không còn issue critical/high. ${truncate(result.summary, 200)}`
        : `${blocking} issue blocking, ${failedTests.length} test fail. ${truncate(result.summary, 200)}`,
    };
  }

  private createVerifyTask(round: number, debugTaskId?: string): TaskState {
    const implementationTasks = this.state.tasks.filter((task) => task.generatedBy === "planner");
    const debugTasks = this.state.tasks.filter((task) => task.role === "debug").map((task) => task.id);
    const dependsOn = [
      ...new Set([
        ...implementationTasks.map((task) => task.id),
        ...debugTasks,
        ...(debugTaskId ? [debugTaskId] : []),
      ]),
    ];
    const changed = [
      ...new Set(implementationTasks.flatMap((task) => task.result?.filesChanged ?? [])),
    ];
    const acceptance = [
      "Chạy toàn bộ test/build đã cấu hình và ghi lại kết quả thật",
      "Đối chiếu thay đổi với acceptance criteria của yêu cầu",
      "Mọi issue critical/high phải có repro và vị trí cụ thể",
    ];
    return createEngineTask({
      id: `verify-${round}`,
      title: `Kiểm thử & đánh giá vòng ${round}`,
      role: "testing",
      description: [
        `Kiểm thử toàn bộ thay đổi cho yêu cầu: ${truncate(this.state.request, 1200)}`,
        "",
        "Chạy test_run suite \"all\" (backend + frontend). Đọc git_diff, đối chiếu acceptance của từng task implementation.",
        "Tìm regression ở các luồng liên quan: phân quyền, validation, trạng thái đơn, tồn kho, thanh toán.",
        "Không sửa code production. Issue phải có severity, file/line, repro, expected/actual.",
        changed.length > 0 ? `File đã thay đổi: ${changed.slice(0, 40).join(", ")}` : "Chưa có file thay đổi được báo cáo.",
        round > 1 ? "Đây là vòng kiểm tra lại sau khi Debug Agent sửa lỗi." : "",
      ]
        .filter(Boolean)
        .join("\n"),
      acceptance,
      dependsOn,
      round,
    });
  }

  private createDebugTask(round: number, verifyTask: TaskState, issues: Issue[]): TaskState {
    const failedTests = verifyTask.result?.testsRun.filter((test) => !test.passed) ?? [];
    const details = {
      issues,
      failedTests: failedTests.map((test) => ({
        suite: test.suite,
        command: test.command,
        exitCode: test.exitCode,
        outputTail: truncate(test.outputTail ?? "", 1500),
      })),
    };
    return createEngineTask({
      id: `debug-${round}`,
      title: `Phân tích & sửa lỗi vòng ${round}`,
      role: "debug",
      description: [
        `Debug các lỗi do Testing Agent phát hiện ở task ${verifyTask.id}.`,
        "",
        "Quy trình bắt buộc:",
        "1. Tái hiện lỗi bằng lệnh/test case trong issues.",
        "2. Đọc code/log/stack trace, xác định root cause có bằng chứng.",
        "3. Sửa tối thiểu, đúng layer; không xoá/nới lỏng test.",
        "4. Chạy lại test đã fail + regression liên quan; chỉ báo done khi xác nhận.",
        "5. Ghi rõ Root cause → Fix → Verification trong summary.",
        "",
        "Chi tiết lỗi:",
        "```json",
        JSON.stringify(details, null, 2).slice(0, 8000),
        "```",
      ].join("\n"),
      acceptance: [
        "Tái hiện được lỗi trước khi sửa",
        "Xác định root cause bằng bằng chứng (file/dòng/log)",
        "Sửa tối thiểu và không làm hỏng test khác",
        "Chạy lại test đã fail và test regression, ghi kết quả thật",
      ],
      dependsOn: [verifyTask.id],
      round,
    });
  }

  private failRun(error: unknown): RunState {
    const message = errorMessage(error);
    this.state.error = message;
    this.state.status = "failed";
    this.state.phase = "done";
    this.state.finishedAt = nowIso();
    this.logger.error("run.failed", `Run thất bại: ${message}`);
    this.finalizeReport();
    return this.state;
  }

  private pauseRun(): RunState {
    this.state.status = "awaiting_approval";
    this.state.updatedAt = nowIso();
    this.writeTasks();
    this.finalizeReport();
    this.logger.warn(
      "run.paused",
      `Run tạm dừng. Xem approval: npm run agent -- approvals ${this.state.id}`,
    );
    return this.state;
  }

  private finalStatus(): RunState["status"] {
    const implementation = this.state.tasks.filter((task) => task.generatedBy === "planner");
    if (this.state.quality.passed === true) return "completed";
    if (implementation.length > 0 && implementation.every((task) => task.status !== "done")) {
      return "failed";
    }
    return "completed_with_issues";
  }

  private finalizeReport(): void {
    try {
      this.writeTasks();
      const reportPath = writeReport(this.state, this.runDir, this.config);
      this.state.reportPath = reportPath;
      this.save();
      this.logger.info("run.report", reportPath);
    } catch (error) {
      this.logger.error("report.error", `Không ghi được báo cáo: ${errorMessage(error)}`);
    }
  }

  private writeTasks(): void {
    try {
      fs.writeFileSync(
        path.join(this.runDir, "tasks.md"),
        renderTasksMarkdown(this.state.tasks, this.state.quality),
      );
    } catch {
      // Không chặn run vì lỗi ghi file phụ.
    }
  }

  private logPlan(): void {
    const plan = this.state.plan;
    if (!plan) return;
    this.logger.info("plan.summary", plan.summary);
    for (const assumption of plan.assumptions) this.logger.info("plan.assumption", `• ${assumption}`);
    for (const risk of plan.risks) this.logger.warn("plan.risk", `• ${risk}`);
    for (const task of plan.tasks) {
      this.logger.info(
        "plan.task",
        `• ${task.id} [${task.role}] ${truncate(task.title, 100)}${
          task.dependsOn.length > 0 ? ` ← ${task.dependsOn.join(", ")}` : ""
        }`,
      );
    }
  }

  private agentFor(role: AgentRole): BaseAgent {
    const existing = this.agents.get(role);
    if (existing) return existing;
    const agent = createAgent(role, {
      llm: this.llm,
      config: this.config,
      tools: this.tools,
      bus: this.bus,
      approvals: this.approvals,
      logger: this.logger,
      workspace: this.workspace,
      runDir: this.runDir,
      repoProfile: this.repoProfile,
      onUsage: (usage) => this.addUsage(usage),
    });
    this.agents.set(role, agent);
    return agent;
  }

  private addUsage(usage: LLMUsage): void {
    this.state.usage.calls += 1;
    this.state.usage.promptTokens += usage.promptTokens;
    this.state.usage.completionTokens += usage.completionTokens;
    this.save();
  }

  private getTask(id: string): TaskState | undefined {
    return this.state.tasks.find((task) => task.id === id);
  }

  private save(): void {
    saveRun(this.state, this.runDir);
  }
}

function isTerminal(status: TaskState["status"]): boolean {
  return ["done", "failed", "blocked", "skipped"].includes(status);
}

function isBlockingIssue(issue: Issue): boolean {
  return issue.severity === "critical" || issue.severity === "high";
}

function mergeFiles(...groups: string[][]): string[] {
  return [...new Set(groups.flat().map((file) => toPosix(file)).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function summarizeResultForFeedback(result: TaskResult, attempt: number, max: number): string {
  const issues = result.issues
    .slice(0, 8)
    .map((issue) => `- [${issue.severity}] ${issue.title}: ${truncate(issue.detail, 300)}`)
    .join("\n");
  return [
    `Lần thử ${attempt}/${max} kết thúc với status=${result.status}.`,
    truncate(result.summary, 1200),
    issues ? `Issues:\n${issues}` : "",
    result.nextSteps.length > 0 ? `Next steps:\n${result.nextSteps.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
