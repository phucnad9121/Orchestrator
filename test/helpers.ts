import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentConfig,
  ApprovalConfig,
  LimitsConfig,
  ProviderConfig,
  ReporterConfig,
  TestSuiteConfig,
  ToolsConfig,
  WorkspaceConfig,
} from "../src/types.js";
import { defaultConfig } from "../src/config.js";
import type { ChatMessage, LLM, LLMRequest, LLMResult, ToolCall } from "../src/llm/types.js";

export interface TestConfigOverrides {
  provider?: Partial<ProviderConfig>;
  limits?: Partial<LimitsConfig>;
  approval?: Partial<ApprovalConfig>;
  workspace?: Partial<WorkspaceConfig>;
  tools?: Partial<ToolsConfig>;
  tests?: Record<string, TestSuiteConfig>;
  reporter?: Partial<ReporterConfig>;
}

export function makeConfig(overrides: TestConfigOverrides = {}): AgentConfig {
  const config = structuredClone(defaultConfig);
  config.provider = {
    type: "mock",
    baseUrl: "http://localhost/v1",
    model: "test-model",
    apiKeyEnv: "TEST_KEY",
    temperature: 0,
    maxTokens: 1024,
    timeoutMs: 5000,
  };
  config.limits = {
    maxStepsPerTask: 6,
    maxTaskAttempts: 1,
    maxFixCycles: 1,
    taskTimeoutMs: 30_000,
    maxParallel: 1,
    maxToolOutputChars: 4000,
    maxFileWriteBytes: 100_000,
    maxContextChars: 8000,
  };
  config.approval = { mode: "gate" };
  config.tests = {};
  config.workspace = {
    allowedRoots: ["."],
    protectedPaths: [".env", "**/.env", "**/.env.local", ".git/**", "docs/Token.md", "node_modules/**"],
    excludeDirs: ["node_modules", "target", "dist", ".git"],
  };
  config.tools = {
    shellAllowlist: ["git", "npm", "node", "mvnw", "mvnw.cmd", "java"],
    denyPatterns: [...defaultConfig.tools.denyPatterns],
    approvalPatterns: [...defaultConfig.tools.approvalPatterns],
  };
  return {
    ...config,
    ...overrides,
    provider: { ...config.provider, ...(overrides.provider ?? {}) },
    limits: { ...config.limits, ...(overrides.limits ?? {}) },
    approval: { ...config.approval, ...(overrides.approval ?? {}) },
    workspace: { ...config.workspace, ...(overrides.workspace ?? {}) },
    tools: { ...config.tools, ...(overrides.tools ?? {}) },
    tests: { ...config.tests, ...(overrides.tests ?? {}) },
    reporter: { ...config.reporter, ...(overrides.reporter ?? {}) },
  };
}

export interface TempWorkspace {
  dir: string;
  cleanup: () => void;
}

export function tempWorkspace(options: { git?: boolean; files?: Record<string, string> } = {}): TempWorkspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-test-"));
  if (options.git !== false) {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  }
  for (const [relative, content] of Object.entries(options.files ?? {})) {
    const absolute = path.join(dir, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, "utf8");
  }
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

export class ScriptedLLM implements LLM {
  readonly label = "scripted";
  readonly calls: LLMRequest[] = [];

  constructor(private readonly handler: (request: LLMRequest, index: number) => LLMResult) {}

  async chat(request: LLMRequest): Promise<LLMResult> {
    this.calls.push(request);
    return this.handler(request, this.calls.length - 1);
  }
}

export function finalResponse(content: unknown): LLMResult {
  return {
    message: {
      role: "assistant",
      content: typeof content === "string" ? content : JSON.stringify(content),
    },
    usage: { promptTokens: 10, completionTokens: 5 },
    finishReason: "stop",
  };
}

export function toolResponse(calls: Array<{ name: string; args: Record<string, unknown> }>): LLMResult {
  const toolCalls: ToolCall[] = calls.map((call, index) => ({
    id: `call_${Date.now()}_${index}`,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  }));
  const message: ChatMessage & { role: "assistant" } = {
    role: "assistant",
    content: null,
    tool_calls: toolCalls,
  };
  return {
    message,
    usage: { promptTokens: 10, completionTokens: 5 },
    finishReason: "tool_calls",
  };
}

export function systemOf(request: LLMRequest): string {
  return request.messages.find((message) => message.role === "system")?.content ?? "";
}

export function lastUserOf(request: LLMRequest): string {
  return [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

export function hasToolResult(request: LLMRequest): boolean {
  return request.messages.some((message) => message.role === "tool");
}
