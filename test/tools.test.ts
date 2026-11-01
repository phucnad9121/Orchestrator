import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ApprovalManager, resolveApproval } from "../src/core/approvals.js";
import { MessageBus } from "../src/core/bus.js";
import { classifyShell } from "../src/core/policy.js";
import { createRunState, prepareRunDir } from "../src/core/state.js";
import { createTaskStates, validatePlan } from "../src/core/plan.js";
import { createDefaultRegistry } from "../src/tools/registry.js";
import type { ToolContext } from "../src/tools/types.js";
import { ApprovalRequiredError, PolicyDeniedError } from "../src/util/errors.js";
import { EventLogger } from "../src/util/logger.js";
import { getGitInfo } from "../src/core/git.js";
import { makeConfig, tempWorkspace } from "./helpers.js";

function makeContext(workspace: string, options: { autoApprove?: boolean } = {}) {
  const config = makeConfig({
    tests: { smoke: { cwd: ".", command: "node --version", timeoutMs: 10_000 } },
  });
  const state = createRunState({
    request: "test",
    workspace,
    mode: "mock",
    git: getGitInfo(workspace),
    maxFixCycles: 1,
  });
  const runDir = path.join(workspace, "orchestrator", "runs", state.id);
  prepareRunDir(runDir);
  const task = createTaskStates(
    validatePlan({
      tasks: [
        {
          id: "be-1",
          title: "Test",
          role: "backend",
          description: "test",
          acceptance: ["ok"],
          dependsOn: [],
        },
      ],
    }),
  )[0];
  if (!task) throw new Error("missing task");
  const logger = new EventLogger(undefined, { quiet: true });
  const approvals = new ApprovalManager({
    state,
    config,
    logger,
    autoApprove: options.autoApprove ?? true,
    interactive: false,
    save: () => {},
  });
  const bus = new MessageBus(runDir);
  const context: ToolContext = {
    workspace,
    config,
    runId: state.id,
    runDir,
    task,
    role: "backend",
    logger,
    approvals,
    bus,
  };
  return { context, state, approvals, config, runDir, task };
}

describe("tools", () => {
  it("đọc, ghi, sửa file trong workspace", async () => {
    const workspace = tempWorkspace({ files: { "backend/src/App.java": "class App {}\n" } });
    try {
      const { context } = makeContext(workspace.dir);
      const registry = createDefaultRegistry();

      const read = await registry.execute("fs_read", JSON.stringify({ path: "backend/src/App.java" }), context);
      expect(read.ok).toBe(true);
      expect(read.output).toContain("class App {}");

      const write = await registry.execute(
        "fs_write",
        JSON.stringify({
          path: "backend/src/New.java",
          content: "class New {}\nclass Other {}\n",
        }),
        context,
      );
      expect(write.ok).toBe(true);
      expect(write.meta?.filesChanged).toContain("backend/src/New.java");
      expect(fs.readFileSync(path.join(workspace.dir, "backend/src/New.java"), "utf8")).toContain("New");

      const edit = await registry.execute(
        "fs_edit",
        JSON.stringify({
          path: "backend/src/New.java",
          oldText: "class New {}",
          newText: "class New { int x; }",
        }),
        context,
      );
      expect(edit.ok).toBe(true);

      const ambiguous = await registry.execute(
        "fs_edit",
        JSON.stringify({
          path: "backend/src/New.java",
          oldText: "class",
          newText: "interface",
        }),
        context,
      );
      expect(ambiguous.ok).toBe(false);
      expect(ambiguous.output).toContain("1 lần");
    } finally {
      workspace.cleanup();
    }
  });

  it("chặn đọc file secret", async () => {
    const workspace = tempWorkspace({ files: { ".env": "SECRET=1\n" } });
    try {
      const { context } = makeContext(workspace.dir);
      const registry = createDefaultRegistry();
      await expect(
        registry.execute("fs_read", JSON.stringify({ path: ".env" }), context),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
    } finally {
      workspace.cleanup();
    }
  });

  it("chạy lệnh an toàn và chặn lệnh nguy hiểm", async () => {
    const workspace = tempWorkspace();
    try {
      const { context } = makeContext(workspace.dir);
      const registry = createDefaultRegistry();
      const status = await registry.execute("shell_run", JSON.stringify({ command: "git status" }), context);
      expect(status.ok).toBe(true);

      await expect(
        registry.execute("shell_run", JSON.stringify({ command: "git push origin main" }), context),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
    } finally {
      workspace.cleanup();
    }
  });

  it("chạy test suite cấu hình và trả meta", async () => {
    const workspace = tempWorkspace();
    try {
      const { context } = makeContext(workspace.dir);
      const registry = createDefaultRegistry();
      const result = await registry.execute("test_run", JSON.stringify({ suite: "smoke" }), context);
      expect(result.ok).toBe(true);
      expect(result.meta?.testsRun?.[0]?.passed).toBe(true);
      expect(result.meta?.testsRun?.[0]?.suite).toBe("smoke");
    } finally {
      workspace.cleanup();
    }
  });

  it("gửi tin nhắn cho agent khác", async () => {
    const workspace = tempWorkspace();
    try {
      const { context } = makeContext(workspace.dir);
      const registry = createDefaultRegistry();
      const result = await registry.execute(
        "team_send",
        JSON.stringify({ to: "frontend", subject: "API contract", body: "GET /api/x" }),
        context,
      );
      expect(result.ok).toBe(true);
      expect(context.bus.all()).toHaveLength(1);
      expect(context.bus.all()[0]?.to).toBe("frontend");
    } finally {
      workspace.cleanup();
    }
  });

  it("tin nhắn riêng chỉ role nhận mới đọc được", async () => {
    const workspace = tempWorkspace();
    try {
      const { context } = makeContext(workspace.dir);
      const registry = createDefaultRegistry();
      const privateMessage = context.bus.send({
        from: "backend",
        to: "frontend",
        subject: "private-frontend",
        body: "Chỉ frontend được đọc.",
      });
      const broadcast = context.bus.send({
        from: "testing",
        to: "all",
        subject: "broadcast",
        body: "Mọi agent đều đọc được.",
      });
      context.bus.send({
        from: "frontend",
        to: "orchestrator",
        subject: "to-orch",
        body: "Chỉ orchestrator/người vận hành cần đọc.",
      });

      expect(context.bus.inbox("backend", context.task.id).map((message) => message.id)).toEqual([
        broadcast.id,
      ]);
      expect(context.bus.inbox("frontend", context.task.id).map((message) => message.id)).toEqual([
        privateMessage.id,
        broadcast.id,
      ]);

      const read = await registry.execute("team_read", "{}", context);
      expect(read.output).toContain("broadcast");
      expect(read.output).not.toContain("private-frontend");
      expect(read.output).not.toContain("to-orch");
    } finally {
      workspace.cleanup();
    }
  });
});

describe("approval", () => {
  it("tạo pending, cấp grant và tiêu thụ grant một lần", async () => {
    const workspace = tempWorkspace();
    try {
      const { state, approvals, config, task } = makeContext(workspace.dir, { autoApprove: false });
      const check = {
        taskId: task.id,
        role: "backend" as const,
        tool: "shell_run",
        argsHash: "hash-1",
        summary: "git commit",
        detail: "git commit -m test",
        policy: classifyShell("git commit -m test", config),
      };

      await expect(approvals.authorize(check)).rejects.toBeInstanceOf(ApprovalRequiredError);
      expect(state.approvals.filter((item) => item.status === "pending")).toHaveLength(1);

      const [pending] = state.approvals;
      if (!pending) throw new Error("missing approval");
      resolveApproval(state, pending.id, "approved");
      expect(state.grants).toHaveLength(1);

      await approvals.authorize(check);
      expect(state.grants[0]?.consumed).toBe(true);

      await expect(approvals.authorize(check)).rejects.toBeInstanceOf(ApprovalRequiredError);
    } finally {
      workspace.cleanup();
    }
  });

  it('mode "deny" chặn cứng hành động cần duyệt, kể cả --yes', async () => {
    const workspace = tempWorkspace();
    try {
      const { state, approvals, config, task } = makeContext(workspace.dir, { autoApprove: true });
      config.approval.mode = "deny";
      const check = {
        taskId: task.id,
        role: "backend" as const,
        tool: "shell_run",
        argsHash: "hash-deny",
        summary: "git commit",
        detail: "git commit -m test",
        policy: classifyShell("git commit -m test", config),
      };

      await expect(approvals.authorize(check)).rejects.toBeInstanceOf(PolicyDeniedError);
      expect(state.approvals).toHaveLength(0);
      expect(state.grants).toHaveLength(0);
    } finally {
      workspace.cleanup();
    }
  });
});
