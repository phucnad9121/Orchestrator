import type { AgentRole, Plan, PlanTask, TaskState } from "../types.js";
import { AGENT_ROLES } from "../types.js";
import { nowIso, slugify } from "../util/text.js";

const IMPLEMENTATION_ROLES: AgentRole[] = ["backend", "frontend"];
const MAX_TASKS = 12;

export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanValidationError";
  }
}

/**
 * Chuẩn hoá và kiểm tra kế hoạch do LLM sinh ra:
 * id duy nhất, role hợp lệ, dependency tồn tại, không cycle.
 */
export function validatePlan(
  raw: unknown,
  source: Plan["source"] = "llm",
): Plan {
  if (!raw || typeof raw !== "object") throw new PlanValidationError("Kế hoạch không phải object JSON.");
  const object = raw as Record<string, unknown>;
  const rawTasks = object.tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    throw new PlanValidationError("Kế hoạch không có task nào.");
  }
  if (rawTasks.length > MAX_TASKS) {
    throw new PlanValidationError(`Kế hoạch có ${rawTasks.length} task, vượt giới hạn ${MAX_TASKS}.`);
  }

  const tasks: PlanTask[] = [];
  const idMap = new Map<string, string>();
  const used = new Set<string>();

  rawTasks.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      throw new PlanValidationError(`Task #${index + 1} không phải object.`);
    }
    const task = item as Record<string, unknown>;
    const originalId = String(task.id ?? `task-${index + 1}`);
    let id = slugify(originalId) || `task-${index + 1}`;
    if (used.has(id)) {
      let suffix = 2;
      while (used.has(`${id}-${suffix}`)) suffix += 1;
      id = `${id}-${suffix}`;
    }
    used.add(id);
    idMap.set(originalId, id);

    const role = String(task.role ?? "").trim().toLowerCase() as AgentRole;
    if (!AGENT_ROLES.includes(role)) {
      throw new PlanValidationError(`Task "${originalId}" có role không hợp lệ: "${String(task.role)}".`);
    }
    if (!IMPLEMENTATION_ROLES.includes(role)) {
      throw new PlanValidationError(
        `Task "${originalId}" dùng role "${role}". Planner chỉ được giao backend/frontend; testing/debug do orchestrator tự động chạy.`,
      );
    }

    const title = String(task.title ?? "").trim();
    const description = String(task.description ?? "").trim();
    if (!title) throw new PlanValidationError(`Task "${originalId}" thiếu title.`);
    if (!description) throw new PlanValidationError(`Task "${originalId}" thiếu description.`);

    const dependsOn = Array.isArray(task.dependsOn)
      ? task.dependsOn.map((value) => String(value))
      : [];
    const acceptance = Array.isArray(task.acceptance)
      ? task.acceptance.map((value) => String(value)).filter(Boolean)
      : [];
    const filesHint = Array.isArray(task.filesHint)
      ? task.filesHint.map((value) => String(value)).filter(Boolean)
      : [];

    tasks.push({
      id,
      title,
      role,
      description,
      acceptance:
        acceptance.length > 0
          ? acceptance
          : ["Hoàn thành đúng mô tả task", "Không làm hỏng build/test hiện có"],
      dependsOn,
      filesHint,
      priority: Number.isFinite(Number(task.priority)) ? Number(task.priority) : index + 1,
    });
  });

  // Ánh xạ dependency sang id đã chuẩn hoá.
  for (const task of tasks) {
    task.dependsOn = task.dependsOn
      .map((dependency) => idMap.get(dependency) ?? dependency)
      .filter((dependency) => dependency !== task.id);
    for (const dependency of task.dependsOn) {
      if (!used.has(dependency)) {
        throw new PlanValidationError(`Task "${task.id}" phụ thuộc task không tồn tại: "${dependency}".`);
      }
    }
  }

  const cycle = findCycle(tasks);
  if (cycle) throw new PlanValidationError(`Kế hoạch có vòng lặp phụ thuộc: ${cycle.join(" → ")}`);

  const assumptions = Array.isArray(object.assumptions)
    ? object.assumptions.map((value) => String(value)).filter(Boolean)
    : [];
  const risks = Array.isArray(object.risks)
    ? object.risks.map((value) => String(value)).filter(Boolean)
    : [];

  return {
    summary: String(object.summary ?? "").trim() || "Kế hoạch phát triển phần mềm",
    assumptions,
    risks,
    tasks: topoSort(tasks),
    source,
  };
}

export function topoSort(tasks: PlanTask[]): PlanTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const result: PlanTask[] = [];

  const visit = (task: PlanTask): void => {
    if (visited.has(task.id)) return;
    if (visiting.has(task.id)) return;
    visiting.add(task.id);
    const dependencies = [...task.dependsOn]
      .map((id) => byId.get(id))
      .filter((dependency): dependency is PlanTask => Boolean(dependency))
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    for (const dependency of dependencies) visit(dependency);
    visiting.delete(task.id);
    visited.add(task.id);
    result.push(task);
  };

  for (const task of [...tasks].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))) visit(task);
  return result;
}

export function findCycle(tasks: PlanTask[]): string[] | null {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const current = state.get(id);
    if (current === "done") return null;
    if (current === "visiting") {
      const start = stack.indexOf(id);
      return [...stack.slice(start >= 0 ? start : 0), id];
    }
    state.set(id, "visiting");
    stack.push(id);
    const task = byId.get(id);
    for (const dependency of task?.dependsOn ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle) return cycle;
  }
  return null;
}

export function createTaskStates(plan: Plan): TaskState[] {
  const timestamp = nowIso();
  return plan.tasks.map((task) => ({
    ...task,
    status: "pending",
    attempts: 0,
    generatedBy: "planner",
    createdAt: timestamp,
    filesChanged: [],
  }));
}

export function createEngineTask(options: {
  id: string;
  title: string;
  role: "testing" | "debug";
  description: string;
  acceptance: string[];
  dependsOn: string[];
  round?: number;
}): TaskState {
  return {
    id: options.id,
    title: options.title,
    role: options.role,
    description: options.description,
    acceptance: options.acceptance,
    dependsOn: options.dependsOn,
    priority: 100,
    status: "ready",
    attempts: 0,
    generatedBy: "engine",
    createdAt: nowIso(),
    filesChanged: [],
    ...(options.round === undefined ? {} : { testRound: options.round }),
  };
}

/**
 * Cập nhật trạng thái pending/ready/skipped dựa trên dependency.
 * Không đụng tới task đang chạy hoặc đã kết thúc.
 */
export function recomputeReady(tasks: TaskState[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      // Task do engine sinh ra (testing/debug) không bị skip theo dependency:
      // verification vẫn phải chạy sau khi implementation lỗi để có chẩn đoán.
      if (task.generatedBy === "engine") continue;
      if (task.status !== "pending" && task.status !== "ready" && task.status !== "skipped") continue;
      const dependencies = task.dependsOn
        .map((id) => byId.get(id))
        .filter((dependency): dependency is TaskState => Boolean(dependency));
      const blockedBy = dependencies
        .filter((dependency) => ["failed", "skipped", "blocked"].includes(dependency.status))
        .map((dependency) => dependency.id);

      if (blockedBy.length > 0) {
        if (task.status !== "skipped") {
          task.status = "skipped";
          task.blockedBy = blockedBy;
          changed = true;
        }
        continue;
      }

      const allDone = dependencies.every((dependency) => dependency.status === "done");
      const desired = allDone ? "ready" : "pending";
      if (task.status !== desired) {
        task.status = desired;
        delete task.blockedBy;
        changed = true;
      }
    }
  }
}

export function nextReadyTask(tasks: TaskState[]): TaskState | undefined {
  return tasks
    .filter((task) => task.status === "ready")
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))[0];
}

/**
 * Chọn tối đa `limit` task ready để chạy song song.
 *
 * Mỗi role chỉ có tối đa một task trong một batch. Cách này giữ cho 2 agent
 * Backend/Frontend có thể chạy đồng thời nhưng không có hai task cùng role
 * tranh nhau sửa cùng vùng code. Với repo có file dùng chung, đặt
 * `maxParallel = 1` để chạy tuần tự.
 */
export function selectReadyTasks(tasks: TaskState[], limit: number): TaskState[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  const selected: TaskState[] = [];
  const roles = new Set<AgentRole>();
  const ready = tasks
    .filter((task) => task.status === "ready")
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.id.localeCompare(b.id));

  for (const task of ready) {
    if (selected.length >= safeLimit) break;
    if (roles.has(task.role)) continue;
    selected.push(task);
    roles.add(task.role);
  }
  return selected;
}

export function allTerminal(tasks: TaskState[]): boolean {
  return tasks.every((task) =>
    ["done", "failed", "blocked", "skipped"].includes(task.status),
  );
}

export function renderTasksMarkdown(tasks: TaskState[], quality?: { cycles: number; maxCycles: number; passed?: boolean }): string {
  const statusLabel: Record<string, string> = {
    pending: "Chờ",
    ready: "Sẵn sàng",
    in_progress: "Đang làm",
    done: "Xong",
    failed: "Lỗi",
    blocked: "Bị chặn",
    skipped: "Bỏ qua",
    needs_approval: "Chờ duyệt",
  };
  const lines = [
    "# Danh sách công việc",
    "",
    "| # | Task | Agent | Phụ thuộc | Trạng thái | Kết quả |",
    "|---|---|---|---|---|---|",
  ];
  tasks.forEach((task, index) => {
    lines.push(
      `| ${index + 1} | ${escape(task.title)} (\`${task.id}\`) | ${task.role} | ${
        task.dependsOn.length > 0 ? task.dependsOn.map((id) => `\`${id}\``).join(", ") : "—"
      } | ${statusLabel[task.status] ?? task.status} | ${escape(task.result?.summary ?? task.error ?? "—")} |`,
    );
  });
  if (quality) {
    lines.push(
      "",
      `Vòng kiểm thử: ${quality.cycles}/${quality.maxCycles} · Kết quả: ${
        quality.passed === undefined ? "chưa chạy" : quality.passed ? "đạt" : "chưa đạt"
      }`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function escape(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 180);
}
