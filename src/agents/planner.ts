import type { AgentConfig, Plan, PlanTask } from "../types.js";
import type { LLM, LLMUsage } from "../llm/types.js";
import type { EventLogger } from "../util/logger.js";
import { errorMessage } from "../util/errors.js";
import { extractJsonObject, truncate } from "../util/text.js";
import { PLANNER_SYSTEM_PROMPT } from "./prompts.js";
import { PlanValidationError, validatePlan } from "../core/plan.js";
import type { ChatMessage } from "../llm/types.js";

export interface PlannerOptions {
  llm: LLM;
  config: AgentConfig;
  logger: EventLogger;
  repoProfile: string;
  onUsage: (usage: LLMUsage) => void;
}

export class Planner {
  constructor(private readonly options: PlannerOptions) {}

  async createPlan(request: string): Promise<Plan> {
    const messages: ChatMessage[] = [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      { role: "user", content: this.buildPrompt(request) },
    ];

    let lastError = "";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      this.options.logger.info(
        "planner.call",
        `Lập kế hoạch (lần ${attempt}/2) với ${this.options.llm.label}…`,
      );
      const response = await this.options.llm.chat({
        messages,
        tools: [],
        temperature: 0.1,
        maxTokens: Math.max(this.options.config.provider.maxTokens, 2048),
      });
      this.options.onUsage(response.usage);
      const raw = extractJsonObject(response.message.content ?? "");
      try {
        const plan = validatePlan(raw, "llm");
        this.options.logger.success(
          "planner.plan",
          `Kế hoạch: ${plan.tasks.length} task (${plan.tasks
            .map((task) => `${task.role}:${task.id}`)
            .join(", ")})`,
        );
        return plan;
      } catch (error) {
        lastError = errorMessage(error);
        this.options.logger.warn("planner.invalid", `Kế hoạch chưa hợp lệ: ${lastError}`);
        if (attempt === 1) {
          messages.push({
            role: "assistant",
            content: response.message.content ?? "",
          });
          messages.push({
            role: "user",
            content: `Kế hoạch trên chưa hợp lệ: ${lastError}\nHãy sửa đúng lỗi và trả lại DUY NHẤT JSON theo schema. Không thêm giải thích.`,
          });
        }
      }
    }

    this.options.logger.warn(
      "planner.fallback",
      `Không nhận được kế hoạch hợp lệ từ LLM (${lastError}). Dùng kế hoạch heuristic tối thiểu.`,
    );
    return heuristicPlan(request, lastError);
  }

  private buildPrompt(request: string): string {
    return [
      "## YÊU CẦU CỦA NGƯỜI DÙNG",
      "```json",
      JSON.stringify({ request }),
      "```",
      "",
      "## BỐI CẢNH REPO",
      this.options.repoProfile,
      "",
      "## RÀNG BUỘC THÊM",
      `- Tối đa 8 task, chỉ role backend/frontend.`,
      `- Lệnh kiểm thử: ${Object.entries(this.options.config.tests)
        .map(([name, suite]) => `${name} (${suite.command})`)
        .join("; ")}.`,
      "- Không giao việc commit/push/deploy/xoá dữ liệu.",
      "- Nếu yêu cầu đã rõ, không cần hỏi lại; nêu giả định trong assumptions.",
      "",
      "Hãy trả về JSON kế hoạch đúng schema.",
    ].join("\n");
  }
}

export function heuristicPlan(request: string, reason: string): Plan {
  const text = request.toLowerCase();
  const wantsFrontend = /(ui|giao diện|giao dien|frontend|trang|màn hình|man hinh|react|responsive)/i.test(text);
  const wantsBackend = /(api|backend|service|database|entity|endpoint|java|spring|jwt|thanh toán|thanh toan|đơn|don hang|tồn kho|ton kho)/i.test(text);
  const includeBackend = wantsBackend || !wantsFrontend;
  const includeFrontend = wantsFrontend || !wantsBackend;

  const tasks: PlanTask[] = [];
  if (includeBackend) {
    tasks.push({
      id: "be-1",
      title: "Phân tích và hoàn thiện backend",
      role: "backend",
      description:
        `Thực hiện phần backend cho yêu cầu: ${truncate(request, 1200)}. ` +
        "Đọc code liên quan, xác định endpoint/service/entity cần sửa, cập nhật test JUnit và chạy test backend.",
      acceptance: [
        "Chức năng backend đáp ứng yêu cầu và đúng kiến trúc Controller → Service → Repository",
        "Có kiểm tra phân quyền/validation cho endpoint thay đổi",
        "Test backend chạy xanh hoặc báo blocked kèm bằng chứng",
      ],
      dependsOn: [],
      filesHint: ["backend/src"],
      priority: 1,
    });
  }
  if (includeFrontend) {
    tasks.push({
      id: "fe-1",
      title: "Cập nhật giao diện và tích hợp API",
      role: "frontend",
      description:
        `Thực hiện phần giao diện cho yêu cầu: ${truncate(request, 1200)}. ` +
        "Đối chiếu API backend, cập nhật component/service, xử lý loading/empty/error và chạy build frontend.",
      acceptance: [
        "Giao diện thể hiện đúng chức năng và khớp API thực tế",
        "Có trạng thái loading/rỗng/lỗi và thông báo tiếng Việt",
        "Build frontend thành công",
      ],
      dependsOn: includeBackend ? ["be-1"] : [],
      filesHint: ["frontend/src"],
      priority: 2,
    });
  }

  return {
    summary: `Kế hoạch heuristic tối thiểu (${tasks.length} task) do LLM không trả kế hoạch hợp lệ.`,
    assumptions: [
      "Kế hoạch được sinh tự động để không chặn quy trình; cần review kỹ trước khi thực thi.",
      reason ? `Lỗi planner: ${truncate(reason, 300)}` : "Không có lỗi cụ thể.",
    ],
    risks: ["Phạm vi task có thể chưa đầy đủ so với yêu cầu thực tế."],
    tasks,
    source: "heuristic",
  };
}

export { PlanValidationError };
