import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultConfig, PKG_ROOT } from "./config.js";
import { Engine } from "./core/engine.js";
import { getGitInfo } from "./core/git.js";
import { prepareRunDir, createRunState, saveRun } from "./core/state.js";
import { EventLogger } from "./util/logger.js";
import type { AgentConfig } from "./types.js";
import type { ChatMessage, LLM, LLMRequest, LLMResult, ToolCall } from "./llm/types.js";

/** Offline showcase: real filesystem tools and Node tests, scripted model replies. */
class DemoLLM implements LLM {
  readonly label = "offline-scripted-demo";
  private callNumber = 0;

  async chat(request: LLMRequest): Promise<LLMResult> {
    this.callNumber += 1;
    const system = request.messages.find((message) => message.role === "system")?.content ?? "";
    if (system.includes("ORCHESTRATOR PLANNER")) return this.final(plan);
    if (system.includes("BACKEND AGENT")) return this.backend(request);
    if (system.includes("FRONTEND AGENT")) return this.frontend(request);
    if (system.includes("TESTING AGENT")) return this.testing(request);
    if (system.includes("DEBUG AGENT")) return this.debug(request);
    return this.final({ status: "blocked", summary: "Demo role không xác định", filesChanged: [], testsRun: [], issues: [], nextSteps: [] });
  }

  private backend(request: LLMRequest): LLMResult {
    if (!usedTool(request, "fs_write")) {
      return this.tool("fs_write", {
        path: "backend/src/discounted-total.cjs",
        content: "module.exports = function discountedTotal(price, percent) {\n  return price * percent;\n};\n",
        reason: "Tạo hàm tính tổng sau giảm giá (demo cố ý có bug để Debug xử lý)",
      });
    }
    if (!usedTool(request, "team_send")) {
      return this.tool("team_send", {
        to: "frontend",
        subject: "Contract hàm tính giảm giá",
        body: "Backend tạo backend/src/discounted-total.cjs, export discountedTotal(price, percent). Frontend có thể gọi hàm này; Testing sẽ phát hiện một lỗi tính toán demo để Debug sửa.",
      });
    }
    return this.final({ status: "done", summary: "Tạo hàm backend và gửi contract riêng cho Frontend.", filesChanged: ["backend/src/discounted-total.cjs"], testsRun: [], issues: [], nextSteps: [] });
  }

  private frontend(request: LLMRequest): LLMResult {
    if (!usedTool(request, "fs_write")) {
      return this.tool("fs_write", {
        path: "frontend/src/discount-preview.cjs",
        content: "const discountedTotal = require('../../backend/src/discounted-total.cjs');\nmodule.exports = (price, percent) => `Tổng sau giảm giá: ${discountedTotal(price, percent)}₫`;\n",
        reason: "Tạo preview giao diện dùng contract của backend",
      });
    }
    return this.final({ status: "done", summary: "Tạo module preview frontend và tích hợp với hàm backend theo tin nhắn contract.", filesChanged: ["frontend/src/discount-preview.cjs"], testsRun: [], issues: [], nextSteps: [] });
  }

  private testing(request: LLMRequest): LLMResult {
    if (!usedTool(request, "test_run")) {
      return this.tool("test_run", { suite: "demo" });
    }
    const testOutput = outputForTool(request, "test_run");
    const passed = testOutput.includes("(exit 0,") || testOutput.includes("— PASS (exit 0,");
    if (passed) {
      return this.final({ status: "done", summary: "Testing chạy lại suite demo thật sau khi Debug sửa; test đã pass.", filesChanged: [], testsRun: [], issues: [], nextSteps: [] });
    }
    if (!usedTool(request, "team_send")) {
      return this.tool("team_send", {
        to: "debug",
        subject: "Demo test tái hiện lỗi giảm giá",
        body: "Suite demo vừa chạy thật và thất bại: discountedTotal(100, 10) phải trả 90 nhưng hiện trả 1000. Hãy tái hiện, sửa tối thiểu rồi chạy lại suite demo.",
      });
    }
    return this.final({ status: "done", summary: "Testing đã chạy suite demo thật, tái hiện lỗi và gửi issue riêng cho Debug.", filesChanged: [], testsRun: [], issues: [], nextSteps: [] });
  }

  private debug(request: LLMRequest): LLMResult {
    if (!usedTool(request, "fs_read")) {
      return this.tool("fs_read", { path: "backend/src/discounted-total.cjs" });
    }
    if (!usedTool(request, "fs_edit")) {
      return this.tool("fs_edit", {
        path: "backend/src/discounted-total.cjs",
        oldText: "return price * percent;",
        newText: "return price - (price * percent) / 100;",
        reason: "Sửa công thức phần trăm sau khi tái hiện lỗi",
      });
    }
    if (!usedTool(request, "test_run")) return this.tool("test_run", { suite: "demo" });
    if (!usedTool(request, "team_send")) {
      return this.tool("team_send", {
        to: "testing",
        subject: "Đã sửa lỗi và xác minh",
        body: "Root cause là dùng price * percent thay vì trừ phần trăm giảm. Đã sửa công thức; suite demo chạy lại với exit code 0.",
      });
    }
    return this.final({ status: "done", summary: "Root cause: sai công thức phần trăm. Fix tối thiểu; suite demo chạy lại thành công.", filesChanged: ["backend/src/discounted-total.cjs"], testsRun: [], issues: [], nextSteps: [] });
  }

  private tool(name: string, args: Record<string, unknown>): LLMResult {
    const call: ToolCall = {
      id: `demo_call_${this.callNumber}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    };
    const message: ChatMessage & { role: "assistant" } = {
      role: "assistant",
      content: null,
      tool_calls: [call],
    };
    return { message, usage: { promptTokens: 0, completionTokens: 0 }, finishReason: "tool_calls" };
  }

  private final(content: unknown): LLMResult {
    return {
      message: { role: "assistant", content: JSON.stringify(content) },
      usage: { promptTokens: 0, completionTokens: 0 },
      finishReason: "stop",
    };
  }
}

const plan = {
  summary: "Demo offline: Backend tạo contract, Frontend tích hợp, Testing bắt lỗi thật, Debug sửa và xác minh.",
  assumptions: ["Demo chạy trong workspace tạm, không sửa source code của sản phẩm."],
  risks: ["LLM được mô phỏng bằng kịch bản cố định; các tool filesystem, test và report chạy thật."],
  tasks: [
    {
      id: "be-1",
      title: "Tạo hàm backend tính giá sau giảm",
      role: "backend",
      description: "Tạo module discountedTotal(price, percent) và thông báo API contract cho Frontend.",
      acceptance: ["Có module backend export hàm giảm giá", "Gửi contract cho Frontend bằng tin nhắn riêng"],
      dependsOn: [],
      filesHint: ["backend/src/discounted-total.cjs"],
      priority: 1,
    },
    {
      id: "fe-1",
      title: "Tạo preview frontend dùng contract backend",
      role: "frontend",
      description: "Tạo module hiển thị tổng sau giảm giá, dùng contract backend được gửi trong inbox.",
      acceptance: ["Frontend gọi module backend theo contract", "Có preview tiếng Việt"],
      dependsOn: ["be-1"],
      filesHint: ["frontend/src/discount-preview.cjs"],
      priority: 2,
    },
  ],
};

function usedTool(request: LLMRequest, name: string): boolean {
  return request.messages.some(
    (message) => message.role === "assistant" && message.tool_calls?.some((call) => call.function.name === name),
  );
}

function outputForTool(request: LLMRequest, name: string): string {
  const call = [...request.messages]
    .reverse()
    .flatMap((message) => message.role === "assistant" ? message.tool_calls ?? [] : [])
    .find((candidate) => candidate.function.name === name);
  if (!call) return "";
  return request.messages.find((message) => message.role === "tool" && message.tool_call_id === call.id)?.content ?? "";
}

export async function runOfflineDemo(): Promise<string> {
  const root = path.join(PKG_ROOT, "runs");
  const demoId = `demo-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const workspace = path.join(root, `${demoId}-workspace`);
  const runDir = path.join(root, demoId);
  fs.mkdirSync(path.join(workspace, "backend", "src"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "frontend", "src"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "demo-test.cjs"),
    [
      'const assert = require("node:assert/strict");',
      'const discountedTotal = require("./backend/src/discounted-total.cjs");',
      'const discountPreview = require("./frontend/src/discount-preview.cjs");',
      'assert.equal(discountedTotal(100, 10), 90, "10% discount on 100 should be 90");',
      'assert.equal(discountPreview(100, 10), "Tổng sau giảm giá: 90₫");',
      'console.log("PASS: 100 with 10% discount = 90");',
      "",
    ].join("\n"),
    "utf8",
  );

  const config: AgentConfig = structuredClone(defaultConfig);
  config.provider.model = "offline-scripted-demo";
  config.limits.maxParallel = 1;
  config.limits.maxFixCycles = 2;
  config.limits.taskTimeoutMs = 60_000;
  config.approval.mode = "gate";
  config.tests = { demo: { cwd: ".", command: "node demo-test.cjs", timeoutMs: 10_000, description: "Demo test có assertion chạy thật bằng Node.js" } };

  const state = createRunState({
    request: "Demo bốn agent: tạo backend/frontend, phát hiện lỗi giảm giá, debug và xác minh.",
    workspace,
    mode: "demo",
    git: getGitInfo(workspace),
    maxFixCycles: config.limits.maxFixCycles,
    id: demoId,
  });
  prepareRunDir(runDir);
  saveRun(state, runDir);
  const engine = new Engine({
    state,
    runDir,
    workspace,
    config,
    llm: new DemoLLM(),
    logger: new EventLogger(runDir),
    autoApprove: false,
    interactive: false,
  });
  const finished = await engine.startNew(state.request, false);
  const reportPath = path.join(runDir, "report.md");
  console.log(`\nDemo status: ${finished.status}`);
  console.log(`Quality passed: ${finished.quality.passed === true}`);
  console.log(`Run report: ${reportPath}`);
  console.log(`Demo source workspace: ${workspace}`);
  console.log(`Agent reports: ${path.join(runDir, "agents")}`);
  if (finished.status !== "completed" || finished.quality.passed !== true) {
    throw new Error(`Demo chưa hoàn thành đúng kỳ vọng. Xem ${reportPath}`);
  }
  return reportPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runOfflineDemo().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
