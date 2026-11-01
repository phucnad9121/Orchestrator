import fs from "node:fs";
import path from "node:path";
import type { AgentConfig, AgentRole, RunState, TaskState, TeamMessage } from "../types.js";
import { AGENT_ROLES } from "../types.js";
import { diffStat, gitStatusText } from "./git.js";
import { escapeTableCell, formatDuration, nowIso, truncate } from "../util/text.js";
import { readJson, writeJson } from "../util/fsx.js";

const RUN_STATUS: Record<string, string> = {
  initializing: "Khởi tạo",
  planning: "Đang lập kế hoạch",
  planned: "Đã có kế hoạch",
  running: "Đang chạy",
  awaiting_approval: "Chờ phê duyệt",
  completed: "Hoàn thành",
  completed_with_issues: "Hoàn thành (còn vấn đề)",
  failed: "Thất bại",
  cancelled: "Đã hủy",
};

const TASK_STATUS: Record<string, string> = {
  pending: "Chờ",
  ready: "Sẵn sàng",
  in_progress: "Đang làm",
  done: "Xong",
  failed: "Lỗi",
  blocked: "Bị chặn",
  skipped: "Bỏ qua",
  needs_approval: "Chờ duyệt",
};

const SEVERITY_ICON: Record<string, string> = {
  critical: "🔴 critical",
  high: "🟠 high",
  medium: "🟡 medium",
  low: "⚪ low",
};

export function writeReport(state: RunState, runDir: string, config: AgentConfig): string {
  const reportPath = path.join(runDir, "report.md");
  const markdown = renderReport(state, config);
  fs.writeFileSync(reportPath, markdown, "utf8");
  const agentReports = writeAgentReports(state, runDir);
  writeJson(path.join(runDir, "summary.json"), buildSummary(state, reportPath, agentReports));
  state.reportPath = reportPath;
  return reportPath;
}

export function renderReport(state: RunState, config: AgentConfig): string {
  const started = state.startedAt ?? state.createdAt;
  const finished = state.finishedAt ?? nowIso();
  const duration = formatDuration(new Date(finished).getTime() - new Date(started).getTime());
  const counts = countByStatus(state.tasks);
  const allIssues = state.tasks.flatMap((task) =>
    (task.result?.issues ?? []).map((issue) => ({ ...issue, taskId: task.id, role: task.role })),
  );
  const blockingIssues = allIssues.filter(
    (issue) => issue.severity === "critical" || issue.severity === "high",
  );
  const pending = state.approvals.filter((approval) => approval.status === "pending");
  const files = [...new Set(state.tasks.flatMap((task) => task.result?.filesChanged ?? task.filesChanged))].sort();

  const lines: string[] = [];
  lines.push(`# Báo cáo đội Agent — ${state.id}`, "");

  if (state.status === "awaiting_approval") {
    lines.push(
      "> ⚠️ **Run đang tạm dừng để chờ phê duyệt.**",
      ">",
      ...pending.map(
        (approval) =>
          `> - \`${approval.id}\` · task \`${approval.taskId}\` · ${approval.summary}  \n>   Duyệt: \`npm run agent -- approve ${state.id} ${approval.id}\` · Từ chối: \`npm run agent -- reject ${state.id} ${approval.id}\``,
      ),
      ">",
      `> Sau khi duyệt: \`npm run agent -- resume ${state.id}\``,
      "",
    );
  }

  lines.push(
    `> **Trạng thái:** ${RUN_STATUS[state.status] ?? state.status} · **Thời gian:** ${duration} · **Chế độ:** ${state.mode}`,
    `>`,
    `> **Yêu cầu:** ${truncate(state.request.replace(/\r?\n/g, " "), 500)}`,
    `>`,
    `> **Workspace:** \`${state.workspace}\` · **Branch:** \`${state.git.branch ?? "—"}\` · **Commit:** \`${state.git.commit ?? "—"}\``,
    "",
    "---",
    "",
  );

  // 1. Tóm tắt
  lines.push("## 1. Tóm tắt điều hành", "");
  lines.push(
    `- Task: **${counts.done ?? 0}/${state.tasks.length}** hoàn thành · ${counts.failed ?? 0} lỗi · ${counts.blocked ?? 0} bị chặn · ${counts.skipped ?? 0} bỏ qua.`,
    `- Vòng kiểm thử: **${state.quality.history.length}** · Kết quả chất lượng: **${
      state.quality.passed === undefined ? "chưa xác định" : state.quality.passed ? "đạt" : "chưa đạt"
    }**.`,
    `- Vấn đề: **${blockingIssues.length}** critical/high · **${allIssues.length}** tổng cộng.`,
    `- File thay đổi (agent báo cáo): **${files.length}**.`,
    `- Song song: tối đa **${config.limits.maxParallel}** task/batch, mỗi role một task.`,
    `- Token: **${state.usage.promptTokens + state.usage.completionTokens}** (${state.usage.calls} lần gọi LLM).`,
    "",
  );
  if (state.error) lines.push(`> ❌ **Lỗi run:** ${state.error}`, "");
  if (state.mode === "mock") {
    lines.push("> ℹ️ **Chế độ mock:** kết quả chỉ kiểm tra luồng điều phối, không phản ánh chất lượng code thật.", "");
  }
  if (state.mode === "demo") {
    lines.push("> ℹ️ **Demo offline:** phản hồi LLM được scripted; thao tác file, nhắn tin, test và sửa lỗi được thực thi thật trong workspace demo.", "");
  }
  if (state.plan?.source === "heuristic") {
    lines.push(
      "> ⚠️ **Kế hoạch heuristic:** LLM không trả kế hoạch hợp lệ; cần review kỹ phạm vi task.",
      "",
    );
  }

  // 2. Kế hoạch
  lines.push("## 2. Kế hoạch & tiến độ", "");
  if (state.plan) {
    lines.push(`**Tóm tắt kế hoạch:** ${state.plan.summary}`, "");
    if (state.plan.assumptions.length > 0) {
      lines.push("**Giả định:**", ...state.plan.assumptions.map((item) => `- ${item}`), "");
    }
    if (state.plan.risks.length > 0) {
      lines.push("**Rủi ro:**", ...state.plan.risks.map((item) => `- ${item}`), "");
    }
  }
  lines.push(
    "| # | Task | Agent | Phụ thuộc | Trạng thái | Lần thử | File | Kết quả |",
    "|---|---|---|---|---|---|---|---|",
  );
  state.tasks.forEach((task, index) => {
    lines.push(
      `| ${index + 1} | ${escapeTableCell(task.title)} (\`${task.id}\`) | ${task.role} | ${
        task.dependsOn.length > 0 ? task.dependsOn.map((id) => `\`${id}\``).join(", ") : "—"
      } | ${TASK_STATUS[task.status] ?? task.status} | ${task.attempts} | ${
        task.result?.filesChanged.length ?? 0
      } | ${escapeTableCell(truncate(task.result?.summary ?? task.error ?? "—", 160))} |`,
    );
  });
  lines.push("");

  // 3. Chi tiết task
  lines.push("## 3. Kết quả theo task", "");
  if (state.tasks.length === 0) lines.push("(chưa có task)", "");
  for (const task of state.tasks) {
    lines.push(...renderTaskDetail(task), "");
  }

  lines.push("### Báo cáo riêng theo agent", "");
  for (const role of AGENT_ROLES) {
    const roleTasks = state.tasks.filter((task) => task.role === role);
    const done = roleTasks.filter((task) => task.status === "done").length;
    lines.push(
      `- [${role}](agents/${role}.md) · ${done}/${roleTasks.length} task hoàn thành${
        roleTasks.length === 0 ? " · chưa nhận task" : ""
      }`,
    );
  }
  lines.push("");

  // 4. Quality loop
  lines.push("## 4. Vòng kiểm thử & sửa lỗi", "");
  if (state.quality.history.length === 0) {
    lines.push("(chưa chạy vòng kiểm thử)", "");
  } else {
    lines.push(
      "| Vòng | Verify task | Debug task | Kết quả | Issue | Tóm tắt |",
      "|---|---|---|---|---|---|",
    );
    for (const item of state.quality.history) {
      lines.push(
        `| ${item.cycle} | \`${item.verifyTaskId}\` | ${item.debugTaskId ? `\`${item.debugTaskId}\`` : "—"} | ${
          item.passed ? "Đạt" : "Chưa đạt"
        } | ${item.issueCount} (${item.blockingIssues} blocking) | ${escapeTableCell(truncate(item.summary, 180))} |`,
      );
    }
    lines.push("");
  }
  if (state.quality.blockedReason) {
    lines.push(`> ⚠️ Không thể xác minh: ${state.quality.blockedReason}`, "");
  }

  // 5. Issues
  lines.push("## 5. Vấn đề còn tồn tại", "");
  if (allIssues.length === 0) {
    lines.push("Không có issue nào được agent ghi nhận.", "");
  } else {
    for (const issue of allIssues) {
      lines.push(
        `### ${SEVERITY_ICON[issue.severity] ?? issue.severity} · ${issue.title}`,
        `- Task: \`${issue.taskId}\` (${issue.role})`,
        ...(issue.file ? [`- Vị trí: \`${issue.file}${issue.line ? `:${issue.line}` : ""}\``] : []),
        `- Chi tiết: ${issue.detail || "—"}`,
        ...(issue.suspectedCause ? [`- Nguyên nhân nghi ngờ: ${issue.suspectedCause}`] : []),
        ...(issue.repro ? [`- Cách tái hiện: \`${issue.repro}\``] : []),
        "",
      );
    }
  }

  // 6. Approvals
  lines.push("## 6. Phê duyệt", "");
  if (state.approvals.length === 0) {
    lines.push("Không có hành động nào cần phê duyệt.", "");
  } else {
    lines.push("| ID | Task | Hành động | Trạng thái | Lý do |", "|---|---|---|---|---|");
    for (const approval of state.approvals) {
      lines.push(
        `| \`${approval.id}\` | \`${approval.taskId}\` | ${escapeTableCell(approval.summary)} | ${
          approval.status === "pending" ? "⏳ Chờ duyệt" : approval.status === "approved" ? "✅ Đã duyệt" : "❌ Từ chối"
        } | ${escapeTableCell(approval.reason)} |`,
      );
    }
    lines.push("");
  }

  // 7. Changes / review
  lines.push("## 7. Thay đổi & cách review", "");
  lines.push(
    "Hệ thống **không tự commit/push**. Thay đổi đang nằm trong working tree để bạn review:",
    "",
    "```bash",
    "git status --short",
    "git diff",
    "git diff --stat",
    "# Khi hài lòng:",
    "git add -A && git commit -m \"feat(<scope>): <mô tả>\"",
    "```",
    "",
  );
  if (files.length > 0) {
    lines.push("**File agent báo cáo đã thay đổi:**", ...files.map((file) => `- \`${file}\``), "");
  } else {
    lines.push("**Không có file nào được agent báo cáo thay đổi.**", "");
  }
  const status = gitStatusText(state.workspace);
  lines.push("**Git status hiện tại:**", "```", truncate(status || "(working tree sạch)", 4000), "```", "");
  const stat = diffStat(state.workspace);
  if (stat.trim()) {
    lines.push("**Diff stat:**", "```", truncate(stat, 4000), "```", "");
  }

  // 8. Usage
  lines.push(
    "## 8. Chi phí & hiệu năng",
    "",
    `- LLM calls: **${state.usage.calls}**`,
    `- Prompt tokens: **${state.usage.promptTokens}**`,
    `- Completion tokens: **${state.usage.completionTokens}**`,
    `- Model: \`${config.provider.model}\` · Provider: \`${config.provider.baseUrl}\``,
    "",
  );

  // 9. Next steps
  lines.push("## 9. Đề xuất tiếp theo", "");
  const nextSteps = [...new Set(state.tasks.flatMap((task) => task.result?.nextSteps ?? []))];
  if (state.status === "awaiting_approval") {
    lines.push("- Duyệt các approval đang chờ rồi chạy `resume`.");
  }
  if (blockingIssues.length > 0) {
    lines.push("- Xử lý các issue critical/high ở mục 5 trước khi merge.");
  }
  if (!state.quality.passed && state.status !== "awaiting_approval") {
    lines.push("- Chạy lại quy trình hoặc giao Debug Agent kiểm tra các lỗi còn lại.");
  }
  if (files.length > 0) {
    lines.push("- Review `git diff`, chạy test thủ công trên môi trường dev trước khi merge.");
  }
  if (nextSteps.length > 0) {
    lines.push(...nextSteps.map((item) => `- ${item}`));
  }
  if (
    blockingIssues.length === 0 &&
    state.quality.passed &&
    files.length === 0 &&
    state.status === "completed"
  ) {
    lines.push("- Không có thay đổi code; nếu yêu cầu cần thay đổi, hãy kiểm tra lại phạm vi kế hoạch.");
  }
  if (lines[lines.length - 1] === "") lines.pop();
  lines.push("");

  // 10. Appendix
  lines.push(
    "## 10. Phụ lục",
    "",
    `- Run directory: \`${state.reportPath ? path.dirname(state.reportPath) : "—"}\``,
    "- `state.json`: trạng thái máy đọc",
    "- `events.jsonl`: nhật ký sự kiện",
    "- `transcripts/<task>.jsonl`: hội thoại từng agent",
    "- `artifacts/<task>-result.json`: kết quả có cấu trúc",
    "- `agents/<role>.md`: báo cáo riêng của từng agent",
    "- `messages.json`: tin nhắn giữa các agent (file-backed)",
    "- `summary.json`: báo cáo tóm tắt cho CI/tooling",
    "",
  );

  return `${lines.join("\n")}\n`;
}

function renderTaskDetail(task: TaskState): string[] {
  const lines = [`### \`${task.id}\` · ${task.title}`, ""];
  lines.push(
    `- Agent: **${task.role}** · Trạng thái: **${TASK_STATUS[task.status] ?? task.status}** · Lần thử: ${task.attempts}`,
    `- Phụ thuộc: ${task.dependsOn.length > 0 ? task.dependsOn.map((id) => `\`${id}\``).join(", ") : "—"}`,
    ...(task.startedAt ? [`- Bắt đầu: ${task.startedAt}`] : []),
    ...(task.finishedAt ? [`- Kết thúc: ${task.finishedAt}`] : []),
    "",
    "**Mô tả:**",
    task.description,
    "",
    "**Acceptance criteria:**",
    ...task.acceptance.map((item) => `- [${task.status === "done" ? "x" : " "}] ${item}`),
    "",
  );
  if (task.error) lines.push(`**Lỗi:** ${task.error}`, "");
  if (task.result) {
    lines.push(
      `**Kết quả:** ${task.result.status} · ${task.result.summary}`,
      "",
    );
    if (task.result.filesChanged.length > 0) {
      lines.push("**File thay đổi:**", ...task.result.filesChanged.map((file) => `- \`${file}\``), "");
    }
    if (task.result.testsRun.length > 0) {
      lines.push("**Test đã chạy:**", "| Suite | Lệnh | Kết quả | Exit |", "|---|---|---|---|");
      for (const test of task.result.testsRun) {
        lines.push(
          `| ${test.suite} | \`${escapeTableCell(test.command)}\` | ${test.passed ? "PASS" : "FAIL"} | ${
            test.exitCode ?? "—"
          } |`,
        );
      }
      lines.push("");
    }
    if (task.result.issues.length > 0) {
      lines.push("**Issue từ task:**");
      for (const issue of task.result.issues) {
        lines.push(
          `- ${SEVERITY_ICON[issue.severity] ?? issue.severity}: ${issue.title}${
            issue.file ? ` (\`${issue.file}${issue.line ? `:${issue.line}` : ""}\`)` : ""
          }`,
        );
      }
      lines.push("");
    }
    if (task.result.notes) lines.push(`**Ghi chú:** ${task.result.notes}`, "");
  }
  return lines;
}

function writeAgentReports(
  state: RunState,
  runDir: string,
): Array<{ role: AgentRole; path: string }> {
  const dir = path.join(runDir, "agents");
  fs.mkdirSync(dir, { recursive: true });
  const messages = readTeamMessages(runDir);
  const reports: Array<{ role: AgentRole; path: string }> = [];
  for (const role of AGENT_ROLES) {
    const file = path.join(dir, `${role}.md`);
    fs.writeFileSync(file, renderAgentReport(state, role, messages), "utf8");
    reports.push({ role, path: path.relative(runDir, file).split(path.sep).join("/") });
  }
  return reports;
}

function readTeamMessages(runDir: string): TeamMessage[] {
  try {
    const messages = readJson<TeamMessage[]>(path.join(runDir, "messages.json"));
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
}

function renderAgentReport(
  state: RunState,
  role: AgentRole,
  messages: TeamMessage[],
): string {
  const tasks = state.tasks.filter((task) => task.role === role);
  const done = tasks.filter((task) => task.status === "done").length;
  const files = [...new Set(tasks.flatMap((task) => task.result?.filesChanged ?? task.filesChanged))].sort();
  const tests = tasks.flatMap((task) => task.result?.testsRun ?? []);
  const issues = tasks.flatMap((task) => task.result?.issues ?? []);
  const relatedMessages = messages.filter(
    (message) => message.from === role || message.to === role || message.to === "all",
  );
  const lines = [
    `# Báo cáo Agent ${role} — ${state.id}`,
    "",
    `> Run: **${state.id}** · Trạng thái run: **${RUN_STATUS[state.status] ?? state.status}**`,
    `>`,
    `> Yêu cầu: ${truncate(state.request.replace(/\r?\n/g, " "), 500)}`,
    "",
    "Báo cáo này do orchestrator tổng hợp từ state của run. Đây không phải kênh chat trực tiếp;",
    "tin nhắn giữa các agent nằm trong `messages.json` và được liệt kê ở cuối báo cáo.",
    "",
    "## Tóm tắt",
    "",
    `- Task được giao: **${tasks.length}** · Hoàn thành: **${done}** · Lỗi/bị chặn: **${tasks.filter((task) => ["failed", "blocked"].includes(task.status)).length}**`,
    `- File đã báo cáo thay đổi: **${files.length}**`,
    `- Test đã chạy: **${tests.length}** · Pass: **${tests.filter((test) => test.passed).length}** · Fail: **${tests.filter((test) => !test.passed).length}**`,
    `- Issue ghi nhận: **${issues.length}** · Critical/high: **${issues.filter((issue) => ["critical", "high"].includes(issue.severity)).length}**`,
    "",
    "## Task",
    "",
  ];

  if (tasks.length === 0) {
    lines.push("Agent chưa được giao task nào trong run này.", "");
  } else {
    lines.push("| Task | Trạng thái | Lần thử | Kết quả |", "|---|---|---|---|");
    for (const task of tasks) {
      lines.push(
        `| \`${task.id}\` ${escapeTableCell(task.title)} | ${TASK_STATUS[task.status] ?? task.status} | ${
          task.attempts
        } | ${escapeTableCell(truncate(task.result?.summary ?? task.error ?? "—", 200))} |`,
      );
    }
    lines.push("");
    for (const task of tasks) {
      lines.push(...renderTaskDetail(task), "");
    }
  }

  lines.push("## File thay đổi", "");
  if (files.length === 0) lines.push("Không có file thay đổi được báo cáo.", "");
  else lines.push(...files.map((file) => `- \`${file}\``), "");

  lines.push("## Test & issue", "");
  if (tests.length === 0) {
    lines.push("- Chưa có test nào được ghi nhận.", "");
  } else {
    lines.push("| Suite | Lệnh | Kết quả | Exit |", "|---|---|---|---|");
    for (const test of tests) {
      lines.push(
        `| ${test.suite} | \`${escapeTableCell(test.command)}\` | ${test.passed ? "PASS" : "FAIL"} | ${
          test.exitCode ?? "—"
        } |`,
      );
    }
    lines.push("");
  }
  if (issues.length === 0) {
    lines.push("Không có issue nào được agent ghi nhận.", "");
  } else {
    for (const issue of issues) {
      lines.push(
        `- ${SEVERITY_ICON[issue.severity] ?? issue.severity}: ${issue.title}${
          issue.file ? ` (\`${issue.file}${issue.line ? `:${issue.line}` : ""}\`)` : ""
        }`,
      );
    }
    lines.push("");
  }

  lines.push("## Tin nhắn liên quan", "");
  if (relatedMessages.length === 0) {
    lines.push("Không có tin nhắn nào liên quan tới agent này.", "");
  } else {
    for (const message of relatedMessages.slice(-50)) {
      lines.push(
        `### ${message.from} → ${message.to} · ${message.subject}`,
        `- Thời gian: ${message.createdAt}${message.taskId ? ` · Task: \`${message.taskId}\`` : ""}`,
        "",
        message.body || "—",
        "",
      );
    }
  }

  lines.push(
    "## Liên kết",
    "",
    `- [Báo cáo tổng](../report.md)`,
    `- [Danh sách task](../tasks.md)`,
    `- [JSON tóm tắt](../summary.json)`,
    "",
  );
  return `${lines.join("\n")}\n`;
}

function countByStatus(tasks: TaskState[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return counts;
}

function buildSummary(
  state: RunState,
  reportPath: string,
  agentReports: Array<{ role: AgentRole; path: string }> = [],
): Record<string, unknown> {
  const issues = state.tasks.flatMap((task) =>
    (task.result?.issues ?? []).map((issue) => ({ ...issue, taskId: task.id, role: task.role })),
  );
  return {
    runId: state.id,
    status: state.status,
    mode: state.mode,
    request: state.request,
    workspace: state.workspace,
    startedAt: state.startedAt ?? state.createdAt,
    finishedAt: state.finishedAt,
    durationMs: state.finishedAt
      ? new Date(state.finishedAt).getTime() - new Date(state.startedAt ?? state.createdAt).getTime()
      : undefined,
    planSource: state.plan?.source,
    tasks: state.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      role: task.role,
      status: task.status,
      attempts: task.attempts,
      summary: task.result?.summary,
      filesChanged: task.result?.filesChanged ?? [],
      testsRun: task.result?.testsRun ?? [],
      issues: task.result?.issues ?? [],
    })),
    quality: state.quality,
    approvals: state.approvals,
    usage: state.usage,
    issues,
    blockingIssues: issues.filter(
      (issue) => issue.severity === "critical" || issue.severity === "high",
    ).length,
    agentReports,
    reportPath,
  };
}

export function printRunSummary(state: RunState): string {
  const counts = countByStatus(state.tasks);
  return [
    `Run: ${state.id} · ${RUN_STATUS[state.status] ?? state.status}`,
    `Task: ${counts.done ?? 0}/${state.tasks.length} xong · ${counts.failed ?? 0} lỗi · ${
      counts.blocked ?? 0
    } blocked · ${counts.needs_approval ?? 0} chờ duyệt`,
    `Quality: ${state.quality.passed === undefined ? "chưa chạy" : state.quality.passed ? "ĐẠT" : "CHƯA ĐẠT"}`,
    state.reportPath ? `Report: ${state.reportPath}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
