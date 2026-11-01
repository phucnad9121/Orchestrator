import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig, ApprovalConfig, LimitsConfig, ProviderConfig } from "./types.js";
import { pathExists } from "./util/fsx.js";

/** Thư mục gốc của package orchestrator (chứa package.json, agent.config.json). */
export const PKG_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export const defaultConfig: AgentConfig = {
  provider: {
    type: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    apiKeyEnv: "LLM_API_KEY",
    temperature: 0.2,
    maxTokens: 4096,
    timeoutMs: 120_000,
  },
  limits: {
    maxStepsPerTask: 24,
    maxTaskAttempts: 2,
    maxFixCycles: 3,
    taskTimeoutMs: 1_200_000,
    maxParallel: 1,
    maxToolOutputChars: 12_000,
    maxFileWriteBytes: 400_000,
    maxContextChars: 14_000,
  },
  approval: { mode: "gate" },
  workspace: {
    allowedRoots: ["."],
    protectedPaths: [
      ".env",
      ".env.local",
      "**/.env",
      "**/.env.local",
      "**/.env.*.local",
      "**/*.pem",
      "**/*.key",
      "**/application-secret*",
      "docs/Token.md",
      ".git/**",
      ".github/**",
      ".opencode/**",
      ".claude/**",
      ".specify/**",
      "node_modules/**",
      "target/**",
      "dist/**",
      "orchestrator/runs",
      "orchestrator/runs/**",
    ],
    excludeDirs: [
      "node_modules",
      "target",
      "dist",
      "coverage",
      ".git",
      ".idea",
      ".vscode",
      ".vite",
    ],
  },
  tools: {
    shellAllowlist: [
      "git",
      "node",
      "npm",
      "npx",
      "mvn",
      "mvnw",
      "mvnw.cmd",
      "java",
      "javac",
      "docker",
      "docker-compose",
      "python",
      "python3",
      "pip",
      "pytest",
      "rg",
      "ls",
      "dir",
      "cat",
      "type",
      "head",
      "tail",
      "findstr",
    ],
    denyPatterns: [
      "\\bgit\\s+push\\b",
      "\\bgit\\b.*\\b(push|reset\\s+--hard|clean\\s+-[a-z]*f)\\b",
      "\\bgit\\s+reset\\s+--hard\\b",
      "\\bgit\\s+clean\\s+-[a-z]*f",
      "\\bgit\\s+branch\\s+-D\\b",
      "\\bgit\\s+remote\\s+remove\\b",
      "\\bgit\\s+config\\s+--global\\b",
      "\\bnode\\s+(-e|--eval)\\b",
      "\\bpython3?\\s+-c\\b",
      "\\b(ruby|perl|php)\\s+-e\\b",
      "\\brm\\s+-rf\\s+[/~.]",
      "\\bdel\\s+/[fs]\\b",
      "\\bRemove-Item\\b",
      "\\bformat\\s+[a-zA-Z]:",
      "\\bshutdown\\b",
      "\\breboot\\b",
      "\\bmvn\\b.*\\bdeploy\\b",
      "\\bmvnw(\\.cmd)?\\b.*\\bdeploy\\b",
      "\\bnpm\\s+publish\\b",
      "\\bdocker\\s+(rm|rmi|system\\s+prune)\\b",
      "\\bdrop\\s+(table|database)\\b",
      "\\btruncate\\s+table\\b",
      "\\bcurl\\b[^|]*\\|\\s*(sh|bash)\\b",
    ],
    approvalPatterns: [
      "\\bgit\\s+(add|commit|checkout|switch|merge|rebase|stash|restore|rm|mv)\\b",
      "\\bgit\\s+config\\b",
      "\\bnpm\\s+(install|ci|uninstall|exec)\\b",
      "\\bmvnw?(\\.cmd)?\\b.*\\binstall\\b",
      "\\bpip\\s+install\\b",
      "\\bnpx\\b",
      "\\bdocker\\b",
    ],
  },
  tests: {
    backend: {
      cwd: "backend",
      command: '"{mvnw}" -q test',
      timeoutMs: 900_000,
      description: "JUnit 5 + Mockito (Spring Boot)",
    },
    frontend: {
      cwd: "frontend",
      command: "npm run build",
      timeoutMs: 600_000,
      description: "Vite production build",
    },
  },
  reporter: { language: "vi", aiSummary: false },
};

export interface LoadConfigOptions {
  workspace: string;
  configPath?: string;
  envFiles?: string[];
  overrides?: ConfigOverrides;
}

export interface ConfigOverrides {
  provider?: Partial<ProviderConfig>;
  limits?: Partial<LimitsConfig>;
  approval?: Partial<ApprovalConfig>;
  maxFixCycles?: number;
}

export interface LoadedConfig {
  config: AgentConfig;
  configPath?: string;
  warnings: string[];
}

export function loadConfig(options: LoadConfigOptions): LoadedConfig {
  const warnings: string[] = [];
  const envFiles = options.envFiles ?? [
    path.join(options.workspace, ".env"),
    path.join(PKG_ROOT, ".env"),
  ];
  // Chỉ nạp biến cấu hình của agent, không nạp secret khác từ .env của dự án.
  const envAllowed = (key: string): boolean =>
    /^(LLM_|AGENT_|ORCHESTRATOR_)/.test(key) || key === "TELEGRAM_NOTIFY";
  for (const file of envFiles) loadDotEnv(file, envAllowed);

  const configPath = options.configPath
    ? path.resolve(options.configPath)
    : path.join(PKG_ROOT, "agent.config.json");

  let fileConfig: Partial<AgentConfig> = {};
  if (pathExists(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<AgentConfig>;
    } catch (error) {
      throw new Error(`agent.config.json không hợp lệ (${configPath}): ${(error as Error).message}`);
    }
  } else if (options.configPath) {
    throw new Error(`Không tìm thấy config: ${configPath}`);
  } else {
    warnings.push(`Không thấy ${configPath}, dùng cấu hình mặc định.`);
  }

  const merged = mergeConfig(defaultConfig, fileConfig);
  applyEnv(merged, warnings);

  if (options.overrides?.provider) {
    Object.assign(merged.provider, options.overrides.provider);
  }
  if (options.overrides?.limits) {
    Object.assign(merged.limits, options.overrides.limits);
  }
  if (options.overrides?.approval) {
    Object.assign(merged.approval, options.overrides.approval);
  }
  if (options.overrides?.maxFixCycles !== undefined) {
    merged.limits.maxFixCycles = options.overrides.maxFixCycles;
  }

  merged.provider.baseUrl = merged.provider.baseUrl.replace(/\/+$/, "");
  if (merged.provider.fallbackBaseUrl) {
    merged.provider.fallbackBaseUrl = merged.provider.fallbackBaseUrl.replace(/\/+$/, "");
  }
  validateConfig(merged);

  return { config: merged, configPath: pathExists(configPath) ? configPath : undefined, warnings };
}

export function assertProviderReady(config: AgentConfig): void {
  if (config.provider.type === "mock") return;
  if (config.provider.type === "openai" && !config.provider.apiKey) {
    throw new Error(
      [
        "Chưa có API key cho LLM.",
        `Hãy đặt ${config.provider.apiKeyEnv} trong orchestrator/.env hoặc biến môi trường.`,
        "Ví dụ: LLM_API_KEY=sk-...",
        "Muốn chạy thử không cần key: thêm --mock",
      ].join("\n"),
    );
  }
  const fallbackParts = [config.provider.fallbackBaseUrl, config.provider.fallbackModel, config.provider.fallbackApiKey];
  if (fallbackParts.some(Boolean) && !fallbackParts.every(Boolean)) {
    throw new Error("Provider dự phòng chưa đủ cấu hình: cần LLM_FALLBACK_BASE_URL, LLM_FALLBACK_MODEL và LLM_FALLBACK_API_KEY.");
  }
}

/** Nạp .env đơn giản, không ghi đè biến đã có trong process.env. */
export function loadDotEnv(file: string, allowed?: (key: string) => boolean): number {
  if (!pathExists(file)) return 0;
  let loaded = 0;
  const content = fs.readFileSync(file, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    if (!key) continue;
    if (allowed && !allowed(key)) continue;
    if (process.env[key] !== undefined) continue;
    let value = (match[2] ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    loaded += 1;
  }
  return loaded;
}

function applyEnv(config: AgentConfig, warnings: string[]): void {
  const provider = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (provider === "mock" || provider === "openai" || provider === "opencode") {
    config.provider.type = provider;
  } else if (provider) {
    warnings.push(`LLM_PROVIDER="${provider}" không hợp lệ, dùng "${config.provider.type}".`);
  }
  if (process.env.LLM_BASE_URL) config.provider.baseUrl = process.env.LLM_BASE_URL;
  if (process.env.LLM_MODEL) config.provider.model = process.env.LLM_MODEL;
  if (process.env.LLM_API_KEY) config.provider.apiKey = process.env.LLM_API_KEY;
  if (process.env.LLM_OPENCODE_SERVER_URL) config.provider.opencodeServerUrl = process.env.LLM_OPENCODE_SERVER_URL;
  if (process.env.LLM_OPENCODE_USERNAME) config.provider.opencodeUsername = process.env.LLM_OPENCODE_USERNAME;
  if (process.env.LLM_OPENCODE_PASSWORD) config.provider.opencodePassword = process.env.LLM_OPENCODE_PASSWORD;
  if (process.env.LLM_FALLBACK_BASE_URL) config.provider.fallbackBaseUrl = process.env.LLM_FALLBACK_BASE_URL;
  if (process.env.LLM_FALLBACK_MODEL) config.provider.fallbackModel = process.env.LLM_FALLBACK_MODEL;
  if (process.env.LLM_FALLBACK_API_KEY) config.provider.fallbackApiKey = process.env.LLM_FALLBACK_API_KEY;

  const apiKeyFromNamedEnv = process.env[config.provider.apiKeyEnv];
  if (apiKeyFromNamedEnv && !config.provider.apiKey) {
    config.provider.apiKey = apiKeyFromNamedEnv;
  }

  const numeric: Array<[string, number, (value: number) => void]> = [
    ["LLM_TEMPERATURE", config.provider.temperature, (value) => (config.provider.temperature = value)],
    ["LLM_MAX_TOKENS", config.provider.maxTokens, (value) => (config.provider.maxTokens = Math.round(value))],
    ["LLM_TIMEOUT_MS", config.provider.timeoutMs, (value) => (config.provider.timeoutMs = Math.round(value))],
  ];
  for (const [name, current, setter] of numeric) {
    const raw = process.env[name];
    if (!raw) continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) setter(parsed);
    else warnings.push(`${name}="${raw}" không phải số, giữ giá trị ${current}.`);
  }

  const mode = process.env.AGENT_APPROVAL_MODE?.trim().toLowerCase();
  if (mode === "gate" || mode === "auto" || mode === "deny") {
    config.approval.mode = mode;
  } else if (mode) {
    warnings.push(`AGENT_APPROVAL_MODE="${mode}" không hợp lệ.`);
  }

  const rawParallel = process.env.AGENT_MAX_PARALLEL?.trim();
  if (rawParallel) {
    const parsed = Number(rawParallel);
    if (Number.isInteger(parsed) && parsed >= 1) {
      config.limits.maxParallel = Math.min(parsed, 8);
    } else {
      warnings.push(
        `AGENT_MAX_PARALLEL="${rawParallel}" không hợp lệ (số nguyên 1..8), giữ ${config.limits.maxParallel}.`,
      );
    }
  }
}

export function mergeConfig(base: AgentConfig, override: Partial<AgentConfig>): AgentConfig {
  const result = structuredClone(base);
  if (override.provider) Object.assign(result.provider, override.provider);
  if (override.limits) Object.assign(result.limits, override.limits);
  if (override.approval) Object.assign(result.approval, override.approval);
  if (override.workspace) {
    if (override.workspace.allowedRoots) result.workspace.allowedRoots = [...override.workspace.allowedRoots];
    if (override.workspace.protectedPaths) result.workspace.protectedPaths = [...override.workspace.protectedPaths];
    if (override.workspace.excludeDirs) result.workspace.excludeDirs = [...override.workspace.excludeDirs];
  }
  if (override.tools) {
    if (override.tools.shellAllowlist) result.tools.shellAllowlist = [...override.tools.shellAllowlist];
    if (override.tools.denyPatterns) result.tools.denyPatterns = [...override.tools.denyPatterns];
    if (override.tools.approvalPatterns) result.tools.approvalPatterns = [...override.tools.approvalPatterns];
  }
  if (override.tests) result.tests = { ...result.tests, ...override.tests };
  if (override.reporter) Object.assign(result.reporter, override.reporter);
  return result;
}

function validateConfig(config: AgentConfig): void {
  if (!config.provider.baseUrl.startsWith("http")) {
    throw new Error(`provider.baseUrl không hợp lệ: ${config.provider.baseUrl}`);
  }
  if (config.provider.fallbackBaseUrl && !config.provider.fallbackBaseUrl.startsWith("http")) {
    throw new Error(`provider.fallbackBaseUrl không hợp lệ: ${config.provider.fallbackBaseUrl}`);
  }
  if (!config.provider.model) throw new Error("provider.model không được rỗng.");
  if (config.limits.maxStepsPerTask < 1) throw new Error("limits.maxStepsPerTask phải >= 1.");
  if (config.limits.maxTaskAttempts < 1) throw new Error("limits.maxTaskAttempts phải >= 1.");
  if (
    !Number.isInteger(config.limits.maxParallel) ||
    config.limits.maxParallel < 1 ||
    config.limits.maxParallel > 8
  ) {
    throw new Error("limits.maxParallel phải là số nguyên trong khoảng 1..8.");
  }
  for (const [name, suite] of Object.entries(config.tests)) {
    if (!suite.cwd || !suite.command) throw new Error(`tests.${name} thiếu cwd hoặc command.`);
  }
}

/** Xác định workspace mặc định: ưu tiên --workspace, env, rồi thư mục cha của orchestrator. */
export function resolveWorkspace(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (process.env.AGENT_WORKSPACE) return path.resolve(process.env.AGENT_WORKSPACE);
  const cwd = process.cwd();
  if (path.basename(cwd).toLowerCase() === "orchestrator") {
    return path.dirname(cwd);
  }
  // Nếu đang đứng trong repo chứa orchestrator/ thì dùng repo root.
  if (pathExists(path.join(cwd, "orchestrator", "agent.config.json"))) return cwd;
  return path.dirname(PKG_ROOT);
}

export function runsRoot(): string {
  const configured = process.env.ORCHESTRATOR_RUNS_DIR;
  return configured ? path.resolve(configured) : path.join(PKG_ROOT, "runs");
}

export function redactedConfig(config: AgentConfig): AgentConfig {
  const clone = structuredClone(config);
  if (clone.provider.apiKey) clone.provider.apiKey = "[REDACTED]";
  if (clone.provider.opencodePassword) clone.provider.opencodePassword = "[REDACTED]";
  if (clone.provider.fallbackApiKey) clone.provider.fallbackApiKey = "[REDACTED]";
  return clone;
}
