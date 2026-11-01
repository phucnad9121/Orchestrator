import fs from "node:fs";
import path from "node:path";
import type { GitInfo, RunState, TaskState } from "../types.js";
import { ensureDir, readJsonStrict, writeJson } from "../util/fsx.js";
import { makeRunId, nowIso } from "../util/text.js";

export interface RunSummary {
  id: string;
  status: string;
  request: string;
  createdAt: string;
  updatedAt: string;
  taskCount: number;
  doneCount: number;
  dir: string;
}

export function createRunState(options: {
  request: string;
  workspace: string;
  mode: "live" | "mock" | "demo";
  git: GitInfo;
  maxFixCycles: number;
  id?: string;
}): RunState {
  const timestamp = nowIso();
  return {
    version: 1,
    id: options.id ?? makeRunId(),
    request: options.request.trim(),
    workspace: options.workspace,
    mode: options.mode,
    status: "initializing",
    phase: "planning",
    createdAt: timestamp,
    updatedAt: timestamp,
    tasks: [],
    approvals: [],
    grants: [],
    usage: { calls: 0, promptTokens: 0, completionTokens: 0 },
    quality: { cycles: 0, maxCycles: options.maxFixCycles, history: [] },
    git: options.git,
  };
}

export function runDirectory(runsRoot: string, runId: string): string {
  return path.join(runsRoot, runId);
}

export function prepareRunDir(runDir: string): void {
  ensureDir(runDir);
  ensureDir(path.join(runDir, "transcripts"));
  ensureDir(path.join(runDir, "artifacts"));
}

export function saveRun(state: RunState, runDir: string): void {
  state.updatedAt = nowIso();
  writeJson(path.join(runDir, "state.json"), state);
}

export function loadRun(runDir: string): RunState {
  return readJsonStrict<RunState>(path.join(runDir, "state.json"), "run state");
}

export function writeRequest(runDir: string, request: string, configSnapshot: unknown): void {
  const body = [
    "# Yêu cầu phát triển",
    "",
    request.trim(),
    "",
    "## Cấu hình run (đã che secret)",
    "",
    "```json",
    JSON.stringify(configSnapshot, null, 2),
    "```",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(runDir, "request.md"), body);
}

export function listRuns(runsRoot: string): RunSummary[] {
  if (!fs.existsSync(runsRoot)) return [];
  const entries = fs.readdirSync(runsRoot, { withFileTypes: true });
  const runs: RunSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(runsRoot, entry.name);
    const stateFile = path.join(dir, "state.json");
    if (!fs.existsSync(stateFile)) continue;
    try {
      const state = readJsonStrict<RunState>(stateFile, "run state");
      runs.push({
        id: state.id,
        status: state.status,
        request: state.request,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        taskCount: state.tasks.length,
        doneCount: state.tasks.filter((task) => task.status === "done").length,
        dir,
      });
    } catch {
      // Bỏ qua run hỏng.
    }
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function findLatestRun(runsRoot: string): RunSummary | undefined {
  return listRuns(runsRoot)[0];
}

export function resolveRunDir(runsRoot: string, runIdOrLatest?: string): string {
  if (runIdOrLatest && runIdOrLatest !== "latest") {
    const exact = runDirectory(runsRoot, runIdOrLatest);
    if (!fs.existsSync(path.join(exact, "state.json"))) {
      throw new Error(`Không tìm thấy run "${runIdOrLatest}" trong ${runsRoot}`);
    }
    return exact;
  }
  const latest = findLatestRun(runsRoot);
  if (!latest) throw new Error(`Chưa có run nào trong ${runsRoot}. Hãy chạy: npm run agent -- run "..."`);
  return latest.dir;
}

export function countTasks(tasks: TaskState[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return counts;
}
