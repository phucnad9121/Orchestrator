import type { AgentConfig, AgentRole, TaskState, TestRunRecord } from "../types.js";
import type { ToolSchema } from "../llm/types.js";
import type { ApprovalManager } from "../core/approvals.js";
import type { MessageBus } from "../core/bus.js";
import type { EventLogger } from "../util/logger.js";
import { truncate } from "../util/text.js";

export interface ToolContext {
  workspace: string;
  config: AgentConfig;
  runId: string;
  runDir: string;
  task: TaskState;
  role: AgentRole;
  logger: EventLogger;
  approvals: ApprovalManager;
  bus: MessageBus;
}

export interface ToolMeta {
  filesChanged?: string[];
  testsRun?: TestRunRecord[];
}

export interface ToolOutput {
  ok: boolean;
  output: string;
  meta?: ToolMeta;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput>;
}

export function text(value: unknown, max = 8000): string {
  return truncate(typeof value === "string" ? value : JSON.stringify(value), max);
}

export function requireString(
  args: Record<string, unknown>,
  name: string,
  options: { allowEmpty?: boolean; maxLength?: number } = {},
): string {
  const value = args[name];
  if (typeof value !== "string") throw new Error(`Tham số "${name}" phải là string.`);
  if (!options.allowEmpty && value.trim() === "") throw new Error(`Tham số "${name}" không được rỗng.`);
  return options.maxLength ? value.slice(0, options.maxLength) : value;
}

export function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`Tham số "${name}" phải là string.`);
  return value;
}

export function optionalNumber(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Tham số "${name}" phải là số.`);
  return parsed;
}

export function toolSchema(definition: ToolDefinition): ToolSchema {
  return {
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    },
  };
}
