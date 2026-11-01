import { describe, expect, it } from "vitest";
import {
  createEngineTask,
  createTaskStates,
  nextReadyTask,
  recomputeReady,
  selectReadyTasks,
  validatePlan,
} from "../src/core/plan.js";
import type { Plan, PlanTask } from "../src/types.js";

const plan = (tasks: PlanTask[]): Plan => ({
  summary: "test",
  assumptions: [],
  risks: [],
  tasks,
  source: "llm",
});

const task = (overrides: Partial<PlanTask>): PlanTask => ({
  id: "be-1",
  title: "Backend",
  role: "backend",
  description: "Làm backend",
  acceptance: ["ok"],
  dependsOn: [],
  priority: 1,
  ...overrides,
});

describe("validatePlan", () => {
  it("chuẩn hoá id, sắp xếp topo và tạo task state", () => {
    const result = validatePlan({
      summary: "Kế hoạch",
      tasks: [
        task({ id: "FE 1", role: "frontend", dependsOn: ["BE 1"], priority: 2 }),
        task({ id: "BE 1", priority: 1 }),
      ],
    });
    expect(result.tasks.map((item) => item.id)).toEqual(["be-1", "fe-1"]);
    expect(result.tasks[1]?.dependsOn).toEqual(["be-1"]);

    const states = createTaskStates(result);
    recomputeReady(states);
    expect(states[0]?.status).toBe("ready");
    expect(states[1]?.status).toBe("pending");
    expect(nextReadyTask(states)?.id).toBe("be-1");
  });

  it("phát hiện dependency không tồn tại", () => {
    expect(() =>
      validatePlan({ tasks: [task({ dependsOn: ["missing"] })] }),
    ).toThrow(/không tồn tại/);
  });

  it("phát hiện vòng lặp", () => {
    expect(() =>
      validatePlan({
        tasks: [
          task({ id: "a", dependsOn: ["b"] }),
          task({ id: "b", dependsOn: ["a"] }),
        ],
      }),
    ).toThrow(/vòng lặp/);
  });

  it("từ chối role testing/debug do planner không được giao", () => {
    expect(() => validatePlan({ tasks: [task({ role: "testing" })] })).toThrow(
      /Planner chỉ được giao/,
    );
  });

  it("từ chối kế hoạch rỗng", () => {
    expect(() => validatePlan({ tasks: [] })).toThrow(/không có task/);
  });
});

describe("selectReadyTasks", () => {
  it("chọn task ready theo priority và chỉ một task mỗi role", () => {
    const states = createTaskStates(
      plan([
        task({ id: "be-1", priority: 1 }),
        task({ id: "be-2", priority: 2 }),
        task({ id: "fe-1", role: "frontend", priority: 3 }),
      ]),
    );
    recomputeReady(states);
    expect(selectReadyTasks(states, 2).map((item) => item.id)).toEqual(["be-1", "fe-1"]);
    expect(selectReadyTasks(states, 1).map((item) => item.id)).toEqual(["be-1"]);
  });

  it("không chọn task pending hoặc task đã terminal", () => {
    const states = createTaskStates(plan([task({ id: "be-1" })]));
    recomputeReady(states);
    const be = states[0];
    if (!be) throw new Error("missing task");
    be.status = "in_progress";
    expect(selectReadyTasks(states, 2)).toHaveLength(0);
  });
});

describe("recomputeReady", () => {
  it("skip task có dependency lỗi và giải phóng task không phụ thuộc", () => {
    const states = createTaskStates(
      plan([
        task({ id: "a" }),
        task({ id: "b", dependsOn: ["a"] }),
        task({ id: "c", priority: 3 }),
      ]),
    );
    recomputeReady(states);
    const a = states.find((item) => item.id === "a");
    if (!a) throw new Error("missing a");
    a.status = "failed";
    recomputeReady(states);
    expect(states.find((item) => item.id === "b")?.status).toBe("skipped");
    expect(states.find((item) => item.id === "c")?.status).toBe("ready");
  });

  it("không skip task do engine sinh ra", () => {
    const states = createTaskStates(plan([task({ id: "a" })]));
    const verify = createEngineTask({
      id: "verify-1",
      title: "Verify",
      role: "testing",
      description: "test",
      acceptance: ["ok"],
      dependsOn: ["a"],
    });
    states.push(verify);
    const a = states.find((item) => item.id === "a");
    if (!a) throw new Error("missing a");
    a.status = "failed";
    recomputeReady(states);
    expect(verify.status).toBe("ready");
  });
});
