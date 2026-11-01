import type { AgentConfig } from "../types.js";
import { extractJsonObject } from "../util/text.js";
import type { ChatMessage, LLM, LLMRequest, LLMResult } from "./types.js";

/**
 * LLM giả lập để smoke-test toàn bộ pipeline mà không cần API key.
 * Không tạo thay đổi code thật — chỉ kiểm tra orchestration/state/report.
 */
export class MockLLM implements LLM {
  readonly label = "mock";

  async chat(request: LLMRequest): Promise<LLMResult> {
    const system = request.messages.find((message) => message.role === "system")?.content ?? "";
    const user = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const usage = { promptTokens: 0, completionTokens: 0 };

    if (/ORCHESTRATOR PLANNER/i.test(system)) {
      const task = extractJsonObject(user) as { request?: string } | null;
      const requestText = task?.request ?? user;
      const wantsFrontend = /(ui|giao diện|frontend|trang|màn hình|react)/i.test(requestText);
      const wantsBackend = /(api|backend|service|database|entity|endpoint|java|spring)/i.test(requestText);
      const includeFrontend = wantsFrontend || !wantsBackend;
      const tasks: unknown[] = [
        {
          id: "be-1",
          title: "Phân tích và hoàn thiện backend theo yêu cầu",
          role: "backend",
          description: `[MOCK] Xử lý phần backend cho yêu cầu: ${requestText.slice(0, 300)}`,
          acceptance: ["Xác định đúng phạm vi thay đổi", "Không phá vỡ build backend"],
          dependsOn: [],
          filesHint: ["backend/src"],
          priority: 1,
        },
      ];
      if (includeFrontend) {
        tasks.push({
          id: "fe-1",
          title: "Cập nhật giao diện theo yêu cầu",
          role: "frontend",
          description: `[MOCK] Xử lý phần giao diện cho yêu cầu: ${requestText.slice(0, 300)}`,
          acceptance: ["Giao diện khớp API", "Build frontend thành công"],
          dependsOn: ["be-1"],
          filesHint: ["frontend/src"],
          priority: 2,
        });
      }
      return assistant(
        JSON.stringify({
          summary: `[MOCK] Kế hoạch mô phỏng cho: ${requestText.slice(0, 200)}`,
          assumptions: ["Chạy ở chế độ mock, không thực hiện thay đổi code."],
          risks: [],
          tasks,
        }),
        usage,
      );
    }

    const isTesting = /TESTING AGENT/i.test(system);
    const taskId = extractTaskId(user);
    const result = {
      status: "done",
      summary: isTesting
        ? `[MOCK] Đã kiểm tra mô phỏng task ${taskId}; không chạy test thật.`
        : `[MOCK] Agent đã xử lý mô phỏng task ${taskId}; không thay đổi file.`,
      filesChanged: [],
      testsRun: isTesting
        ? [{ suite: "mock", command: "mock", passed: true, outputTail: "mock test ok" }]
        : [],
      issues: [],
      nextSteps: [],
      notes: "Chế độ mock: dùng để kiểm tra luồng điều phối, không dùng để đánh giá chất lượng code.",
    };
    return assistant(JSON.stringify(result), usage);
  }
}

function assistant(content: string, usage: { promptTokens: number; completionTokens: number }): LLMResult {
  const message: ChatMessage & { role: "assistant" } = { role: "assistant", content };
  return { message, usage, finishReason: "stop" };
}

function extractTaskId(user: string): string {
  const parsed = extractJsonObject(user) as
    | { id?: string; task?: { id?: string } }
    | null;
  return parsed?.task?.id ?? parsed?.id ?? "unknown";
}

export function createMockLLM(_config: AgentConfig): LLM {
  return new MockLLM();
}
