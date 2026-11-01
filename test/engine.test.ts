import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Engine } from "../src/core/engine.js";
import { resolveApproval } from "../src/core/approvals.js";
import { createRunState, prepareRunDir, saveRun } from "../src/core/state.js";
import { getGitInfo } from "../src/core/git.js";
import { EventLogger } from "../src/util/logger.js";
import { ScriptedLLM, finalResponse, hasToolResult, makeConfig, systemOf, tempWorkspace, toolResponse } from "./helpers.js";
import type { LLM, LLMRequest, LLMResult } from "../src/llm/types.js";

function plannerResponse(): LLMResult {
  return finalResponse({
    summary: "Kế hoạch test",
    assumptions: [],
    risks: [],
    tasks: [
      {
        id: "be-1",
        title: "Thêm backend feature",
        role: "backend",
        description: "Tạo file Java minh hoạ",
        acceptance: ["File tồn tại"],
        dependsOn: [],
        priority: 1,
      },
    ],
  });
}

function plannerParallelResponse(): LLMResult {
  return finalResponse({
    summary: "Kế hoạch song song",
    assumptions: [],
    risks: [],
    tasks: [
      {
        id: "be-1",
        title: "Backend song song",
        role: "backend",
        description: "Tạo file Java",
        acceptance: ["File tồn tại"],
        dependsOn: [],
        priority: 1,
      },
      {
        id: "fe-1",
        title: "Frontend song song",
        role: "frontend",
        description: "Tạo file React",
        acceptance: ["File tồn tại"],
        dependsOn: [],
        priority: 2,
      },
    ],
  });
}

/** LLM có delay để kiểm tra scheduler thật sự chạy 2 role cùng lúc. */
class DelayedLLM implements LLM {
  readonly label = "delayed";
  calls = 0;
  active = 0;
  maxActive = 0;

  async chat(request: LLMRequest): Promise<LLMResult> {
    this.calls += 1;
    const system = systemOf(request);
    if (system.includes("ORCHESTRATOR PLANNER")) return plannerParallelResponse();
    if (system.includes("TESTING AGENT")) return testingPass(request);
    const role = system.includes("BACKEND AGENT")
      ? "backend"
      : system.includes("FRONTEND AGENT")
        ? "frontend"
        : undefined;
    if (!role) {
      return finalResponse({
        status: "blocked",
        summary: "Role không xác định trong test",
        filesChanged: [],
        testsRun: [],
        issues: [],
        nextSteps: [],
      });
    }

    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 60));
    this.active -= 1;

    if (!hasToolResult(request)) {
      const path = role === "backend" ? "backend/src/Parallel.java" : "frontend/src/Parallel.tsx";
      return toolResponse([
        {
          name: "fs_write",
          args: {
            path,
            content: role === "backend" ? "public class Parallel {}\n" : "export const Parallel = 1;\n",
            reason: "Tạo file kiểm tra song song",
          },
        },
      ]);
    }

    return finalResponse({
      status: "done",
      summary: `${role} hoàn thành`,
      filesChanged: [role === "backend" ? "backend/src/Parallel.java" : "frontend/src/Parallel.tsx"],
      testsRun: [],
      issues: [],
      nextSteps: [],
    });
  }
}

function testingPass(request: LLMRequest): LLMResult {
  if (!hasToolResult(request)) {
    return toolResponse([{ name: "test_run", args: { suite: "all" } }]);
  }
  return finalResponse({
    status: "done",
    summary: "Test đạt",
    filesChanged: [],
    testsRun: [
      { suite: "smoke", command: "node --version", passed: true, exitCode: 0, outputTail: "v22" },
    ],
    issues: [],
    nextSteps: [],
  });
}

async function runEngine(options: {
  workspace: string;
  llm: LLM;
  autoApprove: boolean;
  maxFixCycles?: number;
  maxParallel?: number;
}) {
  const config = makeConfig({
    limits: {
      maxFixCycles: options.maxFixCycles ?? 1,
      maxStepsPerTask: 6,
      maxParallel: options.maxParallel ?? 1,
    },
    tests: { smoke: { cwd: ".", command: "node --version", timeoutMs: 5000 } },
  });
  const state = createRunState({
    request: "Thêm backend feature",
    workspace: options.workspace,
    mode: "live",
    git: getGitInfo(options.workspace),
    maxFixCycles: config.limits.maxFixCycles,
  });
  const runDir = path.join(options.workspace, "orchestrator", "runs", state.id);
  prepareRunDir(runDir);
  saveRun(state, runDir);
  const logger = new EventLogger(undefined, { quiet: true });
  const engine = new Engine({
    state,
    runDir,
    workspace: options.workspace,
    config,
    llm: options.llm,
    logger,
    autoApprove: options.autoApprove,
    interactive: false,
  });
  return { state, runDir, engine, config, logger };
}

describe("engine", () => {
  it("chạy end-to-end: plan → implement → verify → report", async () => {
    const workspace = tempWorkspace({ files: { "backend/src/Existing.java": "class Existing {}\n" } });
    try {
      const llm = new ScriptedLLM((request) => {
        const system = systemOf(request);
        if (system.includes("ORCHESTRATOR PLANNER")) return plannerResponse();
        if (system.includes("TESTING AGENT")) return testingPass(request);
        if (!hasToolResult(request)) {
          return toolResponse([
            {
              name: "fs_write",
              args: {
                path: "backend/src/Feature.java",
                content: "public class Feature { public int value() { return 1; } }\n",
                reason: "Thêm feature",
              },
            },
          ]);
        }
        return finalResponse({
          status: "done",
          summary: "Đã thêm Feature.java",
          filesChanged: ["backend/src/Feature.java"],
          testsRun: [],
          issues: [],
          nextSteps: [],
        });
      });

      const { state, runDir, engine } = await runEngine({
        workspace: workspace.dir,
        llm,
        autoApprove: true,
      });
      const finished = await engine.startNew("Thêm backend feature", false);

      expect(finished.status).toBe("completed");
      expect(finished.quality.passed).toBe(true);
      expect(finished.tasks.map((task) => task.id)).toEqual(["be-1", "verify-1"]);
      expect(finished.tasks.every((task) => task.status === "done")).toBe(true);
      expect(fs.existsSync(path.join(workspace.dir, "backend/src/Feature.java"))).toBe(true);
      expect(fs.existsSync(path.join(runDir, "report.md"))).toBe(true);
      expect(fs.existsSync(path.join(runDir, "events.jsonl"))).toBe(true);
      expect(fs.existsSync(path.join(runDir, "summary.json"))).toBe(true);
      const report = fs.readFileSync(path.join(runDir, "report.md"), "utf8");
      expect(report).toContain("Báo cáo đội Agent");
      expect(report).toContain("backend/src/Feature.java");
      expect(finished.usage.calls).toBeGreaterThanOrEqual(3);
    } finally {
      workspace.cleanup();
    }
  });

  it("blocks a claimed test result when test_run was never executed", async () => {
    const workspace = tempWorkspace();
    try {
      const llm = new ScriptedLLM((request) => {
        const system = systemOf(request);
        if (system.includes("ORCHESTRATOR PLANNER")) return plannerResponse();
        if (system.includes("TESTING AGENT")) {
          return finalResponse({
            status: "done",
            summary: "Agent claims tests passed",
            filesChanged: [],
            testsRun: [{ suite: "smoke", command: "not executed", passed: true, exitCode: 0 }],
            issues: [],
            nextSteps: [],
          });
        }
        if (!hasToolResult(request)) {
          return toolResponse([{ name: "fs_write", args: { path: "backend/src/Feature.java", content: "class Feature {}" } }]);
        }
        return finalResponse({ status: "done", summary: "Implementation complete", filesChanged: [], testsRun: [], issues: [], nextSteps: [] });
      });

      const { engine } = await runEngine({ workspace: workspace.dir, llm, autoApprove: true });
      const finished = await engine.startNew("Thêm backend feature", false);
      const verify = finished.tasks.find((task) => task.id === "verify-1");

      expect(finished.quality.passed).toBe(false);
      expect(finished.quality.blockedReason).toContain("smoke");
      expect(verify?.result?.testsRun).toEqual([]);
    } finally {
      workspace.cleanup();
    }
  });

  it("chạy song song một task backend và một task frontend khi maxParallel=2", async () => {
    const workspace = tempWorkspace();
    try {
      const llm = new DelayedLLM();
      const { engine, runDir } = await runEngine({
        workspace: workspace.dir,
        llm,
        autoApprove: true,
        maxParallel: 2,
      });
      const finished = await engine.startNew("Thêm backend và frontend", false);

      expect(finished.status).toBe("completed");
      expect(finished.tasks.filter((task) => task.generatedBy === "planner")).toHaveLength(2);
      expect(
        finished.tasks
          .filter((task) => task.generatedBy === "planner")
          .every((task) => task.status === "done"),
      ).toBe(true);
      expect(llm.maxActive).toBeGreaterThanOrEqual(2);
      expect(fs.existsSync(path.join(runDir, "agents", "backend.md"))).toBe(true);
      expect(fs.existsSync(path.join(runDir, "agents", "frontend.md"))).toBe(true);
      expect(fs.readFileSync(path.join(runDir, "report.md"), "utf8")).toContain("agents/backend.md");
    } finally {
      workspace.cleanup();
    }
  });

  it("test fail → debug sửa → test lại đạt", async () => {
    const workspace = tempWorkspace({ files: { "backend/src/Existing.java": "class Existing {}\n" } });
    try {
      let testingRuns = 0;
      const llm = new ScriptedLLM((request) => {
        const system = systemOf(request);
        if (system.includes("ORCHESTRATOR PLANNER")) return plannerResponse();
        if (system.includes("TESTING AGENT")) {
          if (!hasToolResult(request)) {
            return toolResponse([{ name: "test_run", args: { suite: "all" } }]);
          }
          testingRuns += 1;
          if (testingRuns === 1) {
            return finalResponse({
              status: "done",
              summary: "Phát hiện lỗi",
              filesChanged: [],
              testsRun: [
                { suite: "smoke", command: "node --version", passed: false, exitCode: 1, outputTail: "boom" },
              ],
              issues: [
                {
                  severity: "high",
                  title: "Feature trả sai giá trị",
                  detail: "value() trả 2 thay vì 1",
                  repro: "node --version",
                  file: "backend/src/Feature.java",
                },
              ],
              nextSteps: [],
            });
          }
          return testingPass(request);
        }
        if (system.includes("DEBUG AGENT")) {
          if (!hasToolResult(request)) {
            return toolResponse([
              {
                name: "fs_write",
                args: {
                  path: "backend/src/Fix.java",
                  content: "public class Fix {}\n",
                  reason: "Sửa root cause",
                },
              },
            ]);
          }
          return finalResponse({
            status: "done",
            summary: "Root cause: sai logic. Fix: sửa giá trị. Verification: smoke pass.",
            filesChanged: ["backend/src/Fix.java"],
            testsRun: [],
            issues: [],
            nextSteps: [],
          });
        }
        if (!hasToolResult(request)) {
          return toolResponse([
            {
              name: "fs_write",
              args: { path: "backend/src/Feature.java", content: "class Feature {}\n" },
            },
          ]);
        }
        return finalResponse({
          status: "done",
          summary: "Đã thêm feature",
          filesChanged: ["backend/src/Feature.java"],
          testsRun: [],
          issues: [],
          nextSteps: [],
        });
      });

      const { state, engine, runDir } = await runEngine({
        workspace: workspace.dir,
        llm,
        autoApprove: true,
        maxFixCycles: 1,
      });
      const finished = await engine.startNew("Thêm backend feature", false);

      expect(finished.status).toBe("completed");
      expect(finished.quality.passed).toBe(true);
      expect(finished.quality.cycles).toBe(1);
      expect(finished.quality.history).toHaveLength(2);
      expect(finished.tasks.find((task) => task.id === "verify-1")?.result?.testsRun).toMatchObject([
        { suite: "smoke", command: "node --version", passed: true, exitCode: 0 },
      ]);
      expect(finished.tasks.some((task) => task.id === "debug-1" && task.status === "done")).toBe(true);
      expect(finished.tasks.some((task) => task.id === "verify-2" && task.status === "done")).toBe(true);
      const report = fs.readFileSync(path.join(runDir, "report.md"), "utf8");
      expect(report).toContain("debug-1");
    } finally {
      workspace.cleanup();
    }
  });

  it("tạm dừng khi cần phê duyệt, resume sau khi duyệt thì hoàn thành", async () => {
    const workspace = tempWorkspace();
    try {
      const command = "git commit --allow-empty -m agent-test";
      const llm = new ScriptedLLM((request) => {
        const system = systemOf(request);
        if (system.includes("ORCHESTRATOR PLANNER")) return plannerResponse();
        if (system.includes("TESTING AGENT")) return testingPass(request);
        if (!hasToolResult(request)) {
          return toolResponse([{ name: "shell_run", args: { command, cwd: "." } }]);
        }
        return finalResponse({
          status: "done",
          summary: "Đã commit theo phê duyệt",
          filesChanged: [],
          testsRun: [],
          issues: [],
          nextSteps: [],
        });
      });

      const first = await runEngine({ workspace: workspace.dir, llm, autoApprove: false });
      const paused = await first.engine.startNew("Commit thử", false);
      expect(paused.status).toBe("awaiting_approval");
      expect(paused.tasks.find((task) => task.id === "be-1")?.status).toBe("needs_approval");
      const pending = paused.approvals.filter((approval) => approval.status === "pending");
      expect(pending).toHaveLength(1);

      const approved = resolveApproval(paused, pending[0]?.id ?? "", "approved");
      expect(approved).toHaveLength(1);
      saveRun(paused, first.runDir);

      const logger = new EventLogger(undefined, { quiet: true });
      const engine = new Engine({
        state: paused,
        runDir: first.runDir,
        workspace: workspace.dir,
        config: first.config,
        llm,
        logger,
        autoApprove: false,
        interactive: false,
      });
      const finished = await engine.resume();

      expect(finished.status).toBe("completed");
      expect(finished.quality.passed).toBe(true);
      expect(finished.grants.some((grant) => grant.consumed)).toBe(true);
      const log = execFileSync("git", ["log", "-1", "--pretty=%s"], {
        cwd: workspace.dir,
        encoding: "utf8",
      }).trim();
      expect(log).toContain("agent-test");
    } finally {
      workspace.cleanup();
    }
  });
});
