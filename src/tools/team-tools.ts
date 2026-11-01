import type { AgentRole } from "../types.js";
import { AGENT_ROLES } from "../types.js";
import { requireString, text, type ToolDefinition } from "./types.js";

const RECIPIENTS = [...AGENT_ROLES, "all", "orchestrator"] as const;

export const teamTools: ToolDefinition[] = [
  {
    name: "team_send",
    description:
      "Gửi tin nhắn cho agent khác hoặc orchestrator (ví dụ: báo frontend về API contract, nhờ backend sửa lỗi). Tin nhắn sẽ được đưa vào prompt của task tiếp theo.",
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "string",
          enum: [...RECIPIENTS],
          description: "Người nhận: backend | frontend | testing | debug | all | orchestrator.",
        },
        subject: { type: "string", description: "Tiêu đề ngắn." },
        body: {
          type: "string",
          description: "Nội dung: bối cảnh, yêu cầu cụ thể, file/hàm liên quan, tiêu chí xác nhận.",
        },
      },
      required: ["to", "subject", "body"],
    },
    async execute(args, context) {
      const to = requireString(args, "to").trim().toLowerCase();
      if (!RECIPIENTS.includes(to as (typeof RECIPIENTS)[number])) {
        return { ok: false, output: `Người nhận không hợp lệ: ${to}` };
      }
      const subject = requireString(args, "subject", { maxLength: 160 });
      const body = requireString(args, "body", { maxLength: 4000 });
      const message = context.bus.send({
        from: context.role,
        to: to as AgentRole | "all" | "orchestrator",
        subject,
        body,
        taskId: context.task.id,
      });
      return {
        ok: true,
        output: `Đã gửi tin nhắn ${message.id} tới ${to}: ${subject}`,
      };
    },
  },
  {
    name: "team_read",
    description: "Đọc các tin nhắn gần đây gửi cho vai trò của bạn (hoặc gửi cho all).",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Số tin tối đa (mặc định 10)." },
      },
      required: [],
    },
    async execute(args, context) {
      const limit = Math.max(1, Math.min(Number(args.limit ?? 10) || 10, 30));
      const messages = context.bus
        .all()
        .filter((message) => message.to === context.role || message.to === "all")
        .slice(-limit);
      if (messages.length === 0) return { ok: true, output: "Không có tin nhắn nào." };
      context.bus.markRead(
        messages.filter((message) => !message.readBy.includes(context.task.id)).map((message) => message.id),
        context.task.id,
      );
      return {
        ok: true,
        output: messages
          .map(
            (message) =>
              `[${message.createdAt}] ${message.from} → ${message.to} · ${message.subject}\n${text(
                message.body,
                1200,
              )}`,
          )
          .join("\n\n"),
      };
    },
  },
];
