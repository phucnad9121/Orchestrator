/** Kiểu dữ liệu dùng chung cho toàn bộ orchestrator. */

export type AgentRole = "backend" | "frontend" | "testing" | "debug";

export const AGENT_ROLES: AgentRole[] = ["backend", "frontend", "testing", "debug"];

export type TaskStatus =
  | "pending"
  | "ready"
  | "in_progress"
  | "done"
  | "failed"
  | "blocked"
  | "skipped"
  | "needs_approval";

export type RunStatus =
  | "initializing"
  | "planning"
  | "planned"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "completed_with_issues"
  | "failed"
  | "cancelled";

export type IssueSeverity = "critical" | "high" | "medium" | "low";

export interface Issue {
  id?: string;
  severity: IssueSeverity;
  title: string;
  detail: string;
  file?: string;
  line?: number;
  repro?: string;
  suspectedCause?: string;
}

export interface TestRunRecord {
  suite: string;
  command: string;
  cwd?: string;
  passed: boolean;
  exitCode?: number;
  outputTail?: string;
}

export interface TaskResult {
  status: "done" | "blocked" | "failed";
  summary: string;
  filesChanged: string[];
  testsRun: TestRunRecord[];
  issues: Issue[];
  nextSteps: string[];
  notes?: string;
  parseWarning?: string;
}

export interface PlanTask {
  id: string;
  title: string;
  role: AgentRole;
  description: string;
  acceptance: string[];
  dependsOn: string[];
  filesHint?: string[];
  priority?: number;
}

export interface Plan {
  summary: string;
  assumptions: string[];
  risks: string[];
  tasks: PlanTask[];
  source: "llm" | "heuristic";
}

export interface TaskState extends PlanTask {
  status: TaskStatus;
  attempts: number;
  generatedBy: "planner" | "engine";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: TaskResult;
  error?: string;
  transcriptPath?: string;
  filesChanged: string[];
  approvalId?: string;
  testRound?: number;
  blockedBy?: string[];
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface PendingApproval {
  id: string;
  taskId: string;
  role: AgentRole;
  tool: string;
  argsHash: string;
  summary: string;
  detail: string;
  reason: string;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
  resolution?: string;
}

export interface ApprovalGrant {
  taskId: string;
  tool: string;
  argsHash: string;
  createdAt: string;
  consumed: boolean;
}

export interface UsageRecord {
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

export interface QualityCheck {
  cycle: number;
  verifyTaskId: string;
  debugTaskId?: string;
  passed: boolean;
  issueCount: number;
  blockingIssues: number;
  summary: string;
  at: string;
}

export interface QualityState {
  cycles: number;
  maxCycles: number;
  passed?: boolean;
  blockedReason?: string;
  currentVerifyId?: string;
  currentDebugId?: string;
  history: QualityCheck[];
}

export interface GitInfo {
  isRepo: boolean;
  branch?: string;
  commit?: string;
  dirtyAtStart: boolean;
  status: string;
}

export interface RunState {
  version: 1;
  id: string;
  request: string;
  workspace: string;
  mode: "live" | "mock" | "demo";
  status: RunStatus;
  phase: "planning" | "implementation" | "verification" | "reporting" | "done";
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  plan?: Plan;
  tasks: TaskState[];
  approvals: PendingApproval[];
  grants: ApprovalGrant[];
  usage: UsageRecord;
  quality: QualityState;
  git: GitInfo;
  telegramNotifications?: Partial<Record<RunStatus, string>>;
  error?: string;
  reportPath?: string;
}

export interface TeamMessage {
  id: string;
  from: AgentRole | "orchestrator";
  to: AgentRole | "orchestrator" | "all";
  subject: string;
  body: string;
  taskId?: string;
  createdAt: string;
  readBy: string[];
}

export interface TestSuiteConfig {
  cwd: string;
  command: string;
  timeoutMs?: number;
  description?: string;
}

export interface ProviderConfig {
  type: "openai" | "opencode" | "mock";
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  apiKey?: string;
  opencodeServerUrl?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  fallbackBaseUrl?: string;
  fallbackModel?: string;
  fallbackApiKey?: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface LimitsConfig {
  maxStepsPerTask: number;
  maxTaskAttempts: number;
  maxFixCycles: number;
  taskTimeoutMs: number;
  maxParallel: number;
  maxToolOutputChars: number;
  maxFileWriteBytes: number;
  maxContextChars: number;
}

export interface ApprovalConfig {
  mode: "gate" | "auto" | "deny";
}

export interface WorkspaceConfig {
  allowedRoots: string[];
  protectedPaths: string[];
  excludeDirs: string[];
}

export interface ToolsConfig {
  shellAllowlist: string[];
  denyPatterns: string[];
  approvalPatterns: string[];
}

export interface ReporterConfig {
  language: "vi" | "en";
  aiSummary: boolean;
}

export interface AgentConfig {
  provider: ProviderConfig;
  limits: LimitsConfig;
  approval: ApprovalConfig;
  workspace: WorkspaceConfig;
  tools: ToolsConfig;
  tests: Record<string, TestSuiteConfig>;
  reporter: ReporterConfig;
}
