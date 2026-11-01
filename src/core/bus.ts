import path from "node:path";
import type { AgentRole, TeamMessage } from "../types.js";
import { AGENT_ROLES } from "../types.js";
import { readJson, writeJson } from "../util/fsx.js";
import { newId, nowIso, truncate } from "../util/text.js";

const MAX_BODY = 4000;
const MAX_INBOX = 12;

export class MessageBus {
  private messages: TeamMessage[] = [];
  private readonly file: string;

  constructor(
    runDir: string,
    private readonly onSend?: (message: TeamMessage) => void,
  ) {
    this.file = path.join(runDir, "messages.json");
    const existing = readJson<TeamMessage[]>(this.file);
    if (Array.isArray(existing)) this.messages = existing;
  }

  send(input: {
    from: TeamMessage["from"];
    to: TeamMessage["to"];
    subject: string;
    body: string;
    taskId?: string;
  }): TeamMessage {
    if (input.to !== "all" && input.to !== "orchestrator" && !AGENT_ROLES.includes(input.to)) {
      throw new Error(`Người nhận không hợp lệ: ${input.to}`);
    }
    if (!input.subject.trim()) throw new Error("Tin nhắn phải có subject.");
    const message: TeamMessage = {
      id: newId("msg"),
      from: input.from,
      to: input.to,
      subject: input.subject.trim().slice(0, 160),
      body: truncate(input.body.trim(), MAX_BODY),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      createdAt: nowIso(),
      readBy: [],
    };
    this.messages.push(message);
    this.persist();
    this.onSend?.(message);
    return message;
  }

  /** Tin nhắn gửi tới role (hoặc all) mà task hiện tại chưa đọc. */
  inbox(role: AgentRole, taskId: string): TeamMessage[] {
    return this.messages
      .filter(
        (message) =>
          (message.to === role || message.to === "all") && !message.readBy.includes(taskId),
      )
      .slice(-MAX_INBOX);
  }

  markRead(messageIds: string[], taskId: string): void {
    let changed = false;
    for (const message of this.messages) {
      if (messageIds.includes(message.id) && !message.readBy.includes(taskId)) {
        message.readBy.push(taskId);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  all(): TeamMessage[] {
    return [...this.messages];
  }

  private persist(): void {
    writeJson(this.file, this.messages);
  }
}
