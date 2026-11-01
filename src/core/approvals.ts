import { createInterface } from "node:readline/promises";
import type { AgentConfig, ApprovalGrant, PendingApproval, RunState } from "../types.js";
import type { EventLogger } from "../util/logger.js";
import { ApprovalRequiredError, PolicyDeniedError } from "../util/errors.js";
import { newId, nowIso, redactSecrets, truncate } from "../util/text.js";
import type { PolicyResult } from "./policy.js";

export interface ApprovalCheck {
  taskId: string;
  role: PendingApproval["role"];
  tool: string;
  argsHash: string;
  summary: string;
  detail: string;
  policy: PolicyResult;
}

export interface ApprovalManagerOptions {
  state: RunState;
  config: AgentConfig;
  logger: EventLogger;
  autoApprove: boolean;
  interactive: boolean;
  save: () => void;
}

/**
 * Cổng phê duyệt cho hành động có rủi ro.
 * - allow: chạy luôn
 * - deny: chặn cứng
 * - ask: tự duyệt (--yes/mode auto), dùng grant đã phê duyệt, hỏi trực tiếp, hoặc tạo
 *   approval pending rồi tạm dừng run.
 */
export class ApprovalManager {
  private prompting = false;

  constructor(private readonly options: ApprovalManagerOptions) {}

  async authorize(check: ApprovalCheck): Promise<void> {
    const { decision, reason } = check.policy;
    if (decision === "allow") return;
    if (decision === "deny") {
      this.options.logger.warn("policy.denied", `Chặn: ${check.summary}`, { reason });
      throw new PolicyDeniedError(reason);
    }

    // Mode "deny": chặn cứng mọi hành động cần phê duyệt, kể cả khi có --yes.
    if (this.options.config.approval.mode === "deny") {
      const message = `Chế độ phê duyệt "deny" chặn hành động: ${check.summary}. Lý do: ${reason}`;
      this.options.logger.warn("policy.denied", message);
      throw new PolicyDeniedError(message);
    }

    if (this.options.autoApprove || this.options.config.approval.mode === "auto") {
      this.record(check, "approved", "Tự động phê duyệt (--yes/mode auto)");
      this.options.logger.warn("approval.auto", `Tự duyệt: ${check.summary}`);
      return;
    }

    const grant = this.findGrant(check);
    if (grant) {
      grant.consumed = true;
      this.options.save();
      this.options.logger.info("approval.grant", `Dùng phê duyệt đã cấp: ${check.summary}`);
      return;
    }

    if (
      this.options.config.approval.mode === "gate" &&
      this.options.interactive &&
      !this.prompting &&
      process.stdin.isTTY &&
      process.stdout.isTTY
    ) {
      const accepted = await this.ask(check);
      this.record(check, accepted ? "approved" : "rejected", accepted ? "Người dùng đồng ý" : "Người dùng từ chối");
      if (!accepted) {
        throw new PolicyDeniedError("Người dùng đã từ chối hành động này.");
      }
      return;
    }

    const approval = this.createPending(check);
    this.options.logger.warn(
      "approval.pending",
      `Cần phê duyệt (${approval.id}): ${approval.summary}. Chạy: agent approve ${this.options.state.id} ${approval.id}`,
    );
    throw new ApprovalRequiredError(approval);
  }

  private findGrant(check: ApprovalCheck): ApprovalGrant | undefined {
    return this.options.state.grants.find(
      (grant) =>
        !grant.consumed &&
        grant.taskId === check.taskId &&
        grant.tool === check.tool &&
        grant.argsHash === check.argsHash,
    );
  }

  private createPending(check: ApprovalCheck): PendingApproval {
    const existing = this.options.state.approvals.find(
      (approval) =>
        approval.status === "pending" &&
        approval.taskId === check.taskId &&
        approval.tool === check.tool &&
        approval.argsHash === check.argsHash,
    );
    if (existing) return existing;

    const approval: PendingApproval = {
      id: newId("apr"),
      taskId: check.taskId,
      role: check.role,
      tool: check.tool,
      argsHash: check.argsHash,
      summary: redactSecrets(check.summary),
      detail: truncate(redactSecrets(check.detail), 4000),
      reason: redactSecrets(check.policy.reason),
      status: "pending",
      createdAt: nowIso(),
    };
    this.options.state.approvals.push(approval);
    this.options.save();
    return approval;
  }

  private record(check: ApprovalCheck, status: "approved" | "rejected", resolution: string): void {
    this.options.state.approvals.push({
      id: newId("apr"),
      taskId: check.taskId,
      role: check.role,
      tool: check.tool,
      argsHash: check.argsHash,
      summary: redactSecrets(check.summary),
      detail: truncate(redactSecrets(check.detail), 4000),
      reason: redactSecrets(check.policy.reason),
      status,
      createdAt: nowIso(),
      resolvedAt: nowIso(),
      resolution,
    });
    this.options.save();
  }

  private async ask(check: ApprovalCheck): Promise<boolean> {
    this.prompting = true;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      this.options.logger.raw("");
      this.options.logger.raw("┌─ CẦN PHÊ DUYỆT ─────────────────────────────────────────");
      this.options.logger.raw(`│ Task:   ${check.taskId} (${check.role})`);
      this.options.logger.raw(`│ Hành động: ${check.summary}`);
      this.options.logger.raw(`│ Lý do:  ${check.policy.reason}`);
      this.options.logger.raw(`│ Chi tiết:`);
      for (const line of check.detail.split(/\r?\n/).slice(0, 12)) {
        this.options.logger.raw(`│   ${line}`);
      }
      this.options.logger.raw("└─────────────────────────────────────────────────────────");
      const answer = await rl.question("Đồng ý? [y/N] ");
      return /^(y|yes|đồng ý|dong y)$/i.test(answer.trim());
    } finally {
      this.prompting = false;
      rl.close();
    }
  }
}

export function pendingApprovals(state: RunState): PendingApproval[] {
  return state.approvals.filter((approval) => approval.status === "pending");
}

export function resolveApproval(
  state: RunState,
  approvalId: string,
  decision: "approved" | "rejected",
  reason?: string,
): PendingApproval[] {
  const targets =
    approvalId === "all"
      ? pendingApprovals(state)
      : state.approvals.filter((approval) => approval.id === approvalId && approval.status === "pending");
  if (targets.length === 0) {
    throw new Error(`Không tìm thấy approval đang chờ: ${approvalId}`);
  }
  for (const approval of targets) {
    approval.status = decision;
    approval.resolvedAt = nowIso();
    approval.resolution = reason ?? (decision === "approved" ? "Người dùng phê duyệt" : "Người dùng từ chối");
    if (decision === "approved") {
      state.grants.push({
        taskId: approval.taskId,
        tool: approval.tool,
        argsHash: approval.argsHash,
        createdAt: nowIso(),
        consumed: false,
      });
    }
  }
  return targets;
}
