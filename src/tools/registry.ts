import type { ToolSchema } from "../llm/types.js";
import { ApprovalRequiredError, PolicyDeniedError, errorMessage } from "../util/errors.js";
import { fsTools } from "./fs-tools.js";
import { shellTools } from "./shell-tools.js";
import { teamTools } from "./team-tools.js";
import { testTools } from "./test-tools.js";
import type { ToolContext, ToolDefinition, ToolOutput } from "./types.js";
import { toolSchema } from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(tools: ToolDefinition[]) {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw new Error(`Tool trùng tên: ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  schemas(): ToolSchema[] {
    return this.list().map((tool) => toolSchema(tool));
  }

  describeForPrompt(): string {
    return this.list()
      .map((tool) => {
        const properties = tool.parameters.properties as Record<string, { description?: string }> | undefined;
        const args = Object.entries(properties ?? {})
          .map(([name, schema]) => `${name}${schema.description ? ` (${schema.description})` : ""}`)
          .join(", ");
        return `- ${tool.name}: ${tool.description}${args ? `\n  Tham số: ${args}` : ""}`;
      })
      .join("\n");
  }

  async execute(name: string, rawArguments: string, context: ToolContext): Promise<ToolOutput> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        ok: false,
        output: `Tool "${name}" không tồn tại. Các tool hợp lệ: ${this.list().map((item) => item.name).join(", ")}`,
      };
    }
    let args: Record<string, unknown>;
    try {
      args = rawArguments.trim() ? (JSON.parse(rawArguments) as Record<string, unknown>) : {};
    } catch (error) {
      return {
        ok: false,
        output: `Tham số JSON của ${name} không hợp lệ: ${errorMessage(error)}. Hãy gọi lại với JSON đúng.`,
      };
    }
    try {
      return await tool.execute(args, context);
    } catch (error) {
      if (error instanceof ApprovalRequiredError || error instanceof PolicyDeniedError) throw error;
      return {
        ok: false,
        output: `Tool ${name} lỗi: ${errorMessage(error)}`,
      };
    }
  }
}

export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry([...fsTools, ...shellTools, ...testTools, ...teamTools]);
}

export type { ToolContext, ToolDefinition, ToolOutput } from "./types.js";
