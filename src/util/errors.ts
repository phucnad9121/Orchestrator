import type { PendingApproval } from "../types.js";

/** Lỗi do chính sách an toàn chặn — agent không thể vượt qua. */
export class PolicyDeniedError extends Error {
  readonly code: string;

  constructor(message: string, code = "POLICY_DENIED") {
    super(message);
    this.name = "PolicyDeniedError";
    this.code = code;
  }
}

/** Lỗi cần con người phê duyệt trước khi tiếp tục. */
export class ApprovalRequiredError extends Error {
  readonly approval: PendingApproval;

  constructor(approval: PendingApproval) {
    super(`Cần phê duyệt: ${approval.summary}`);
    this.name = "ApprovalRequiredError";
    this.approval = approval;
  }
}

/** Vượt quá ngân sách bước/thời gian/token của một task. */
export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: string }).name === "AbortError"
  );
}
