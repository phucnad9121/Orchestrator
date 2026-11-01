import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startRunServer, type RunServer } from "../src/server.js";
import { createTaskStates, recomputeReady, validatePlan } from "../src/core/plan.js";
import { createRunState, loadRun, prepareRunDir, saveRun } from "../src/core/state.js";
import { writeReport } from "../src/core/reporter.js";
import { getGitInfo } from "../src/core/git.js";
import { makeConfig, tempWorkspace, type TempWorkspace } from "./helpers.js";

let workspace: TempWorkspace | undefined;
let started: RunServer | undefined;
let previousRunsDir: string | undefined;

afterEach(async () => {
  if (started) {
    const server = started.server;
    started = undefined;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (previousRunsDir === undefined) delete process.env.ORCHESTRATOR_RUNS_DIR;
  else process.env.ORCHESTRATOR_RUNS_DIR = previousRunsDir;
  workspace?.cleanup();
  workspace = undefined;
});

describe("dashboard server", () => {
  it("phục vụ state, SSE, báo cáo agent và duyệt approval", async () => {
    workspace = tempWorkspace({ files: { "backend/src/Existing.java": "class Existing {}\n" } });
    const config = makeConfig();
    const state = createRunState({
      request: "Kiểm tra dashboard realtime",
      workspace: workspace.dir,
      mode: "live",
      git: getGitInfo(workspace.dir),
      maxFixCycles: 1,
    });
    const plan = validatePlan({
      summary: "Kế hoạch dashboard",
      tasks: [
        {
          id: "be-1",
          title: "Backend task",
          role: "backend",
          description: "Làm backend",
          acceptance: ["ok"],
          dependsOn: [],
          priority: 1,
        },
      ],
    });
    state.plan = plan;
    state.tasks = createTaskStates(plan);
    recomputeReady(state.tasks);
    const task = state.tasks[0];
    if (!task) throw new Error("missing task");
    task.status = "needs_approval";
    state.status = "awaiting_approval";
    state.phase = "implementation";
    state.approvals.push({
      id: "apr-test",
      taskId: "be-1",
      role: "backend",
      tool: "shell_run",
      argsHash: "hash",
      summary: "Chạy lệnh test",
      detail: "git status",
      reason: "Cần xác nhận",
      status: "pending",
      createdAt: new Date().toISOString(),
    });

    const runsDir = path.join(workspace.dir, "runs");
    const runDir = path.join(runsDir, state.id);
    prepareRunDir(runDir);
    saveRun(state, runDir);
    writeReport(state, runDir, config);
    fs.writeFileSync(
      path.join(runDir, "events.jsonl"),
      `${JSON.stringify({ ts: new Date().toISOString(), level: "info", event: "test.event", message: "hello SSE" })}\n`,
      "utf8",
    );

    previousRunsDir = process.env.ORCHESTRATOR_RUNS_DIR;
    process.env.ORCHESTRATOR_RUNS_DIR = runsDir;
    started = await startRunServer({ runId: state.id, port: 0 });
    const base = started.url.replace(/\/$/, "");

    const stateResponse = await fetch(`${base}/api/runs/${state.id}/state`);
    expect(stateResponse.status).toBe(200);
    const loaded = (await stateResponse.json()) as { status: string; tasks: unknown[] };
    expect(loaded.status).toBe("awaiting_approval");
    expect(loaded.tasks).toHaveLength(1);

    const agentResponse = await fetch(`${base}/api/runs/${state.id}/agents/backend`);
    expect(agentResponse.status).toBe(200);
    expect(await agentResponse.text()).toContain("Báo cáo Agent backend");

    const controller = new AbortController();
    const eventResponse = await fetch(`${base}/api/runs/${state.id}/events`, {
      signal: controller.signal,
    });
    expect(eventResponse.status).toBe(200);
    const reader = eventResponse.body?.getReader();
    let streamText = "";
    if (reader) {
      const deadline = Date.now() + 3000;
      const decoder = new TextDecoder();
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        streamText += decoder.decode(value);
        if (streamText.includes("event: log")) break;
      }
    }
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    expect(streamText).toContain("event: ready");
    expect(streamText).toContain("test.event");
    expect(streamText).toContain("hello SSE");

    const wrongContentType = await fetch(
      `${base}/api/runs/${state.id}/approvals/apr-test/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "approve",
      },
    );
    expect(wrongContentType.status).toBe(415);

    const approveResponse = await fetch(`${base}/api/runs/${state.id}/approvals/apr-test/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Duyệt từ test" }),
    });
    expect(approveResponse.status).toBe(200);
    const approvePayload = (await approveResponse.json()) as { ok: boolean; hint: string };
    expect(approvePayload.ok).toBe(true);
    expect(approvePayload.hint).toContain("resume");

    const after = loadRun(runDir);
    expect(after.approvals[0]?.status).toBe("approved");
    expect(after.grants).toHaveLength(1);
  });
});
