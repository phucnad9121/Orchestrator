import fs from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";

type RpcRequest = { jsonrpc: "2.0"; id?: string | number; method: string; params?: Record<string, unknown> };

const TOOLS = [
  {
    name: "run_agent",
    description: "Chạy đội agent để phân tích, sửa code và kiểm chứng trong một repository local do caller chỉ định. Run dùng approval gate hiện có; nếu cần duyệt sẽ trả run_id và trạng thái awaiting_approval.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: { type: "string", description: "Đường dẫn tuyệt đối tới repository local cần sửa." },
        request: { type: "string", description: "Mô tả thay đổi cần thực hiện." },
      },
      required: ["repo_path", "request"],
      additionalProperties: false,
    },
  },
  {
    name: "get_run_status",
    description: "Xem trạng thái và tiến độ một run agent.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"], additionalProperties: false },
  },
  {
    name: "list_pending_approvals",
    description: "Liệt kê các approval đang chờ cho một run.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"], additionalProperties: false },
  },
  {
    name: "resolve_approval",
    description: "Duyệt hoặc từ chối approval đang chờ. Sau khi duyệt, gọi resume_run để tiếp tục run.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        approval_id: { type: "string", description: "ID approval hoặc all." },
        decision: { type: "string", enum: ["approve", "reject"] },
        reason: { type: "string" },
      },
      required: ["run_id", "approval_id", "decision"],
      additionalProperties: false,
    },
  },
  {
    name: "resume_run",
    description: "Tiếp tục run đã tạm dừng sau khi approval được duyệt.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"], additionalProperties: false },
  },
];

/** MCP stdio server. All protocol messages go to stdout; diagnostics go to stderr. */
export async function startMcpServer(): Promise<void> {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    void processLine(line);
  }
}

async function processLine(line: string): Promise<void> {
  let request: RpcRequest | undefined;
  try {
    request = JSON.parse(line) as RpcRequest;
    const result = await handleRequest(request);
    if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (request && request.id !== undefined) {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message } });
    } else {
      process.stderr.write(`MCP request error: ${message}\n`);
    }
  }
}

async function handleRequest(request: RpcRequest): Promise<unknown> {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-team", version: "0.1.0" },
      };
    case "notifications/initialized":
    case "notifications/cancelled":
    case "notifications/progress":
      return {};
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return callTool(request.params ?? {});
    default:
      throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 });
  }
}

async function callTool(params: Record<string, unknown>): Promise<unknown> {
  const name = requireString(params.name, "name");
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  let output: string;
  try {
    switch (name) {
      case "run_agent": {
        const repo = requireString(args.repo_path, "repo_path");
        const request = requireString(args.request, "request");
        if (!isAbsolutePath(repo)) throw new Error("repo_path phải là đường dẫn tuyệt đối.");
        const stat = fs.statSync(repo);
        if (!stat.isDirectory()) throw new Error("repo_path phải là thư mục.");
        output = await invokeCli(["run", "--workspace", repo, "--no-interactive", request]);
        break;
      }
      case "get_run_status":
        output = await invokeCli(["status", requireString(args.run_id, "run_id")]);
        break;
      case "list_pending_approvals":
        output = await invokeCli(["approvals", requireString(args.run_id, "run_id")]);
        break;
      case "resolve_approval": {
        const runId = requireString(args.run_id, "run_id");
        const approvalId = requireString(args.approval_id, "approval_id");
        const decision = requireString(args.decision, "decision");
        if (decision !== "approve" && decision !== "reject") throw new Error("decision phải là approve hoặc reject.");
        output = await invokeCli([decision, runId, approvalId, ...(decision === "reject" && typeof args.reason === "string" ? [args.reason] : [])]);
        break;
      }
      case "resume_run":
        output = await invokeCli(["resume", requireString(args.run_id, "run_id"), "--no-interactive"]);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: output.slice(0, 24_000) }], isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: message.slice(0, 24_000) }], isError: true };
  }
}

function invokeCli(args: string[]): Promise<string> {
  const entry = process.argv[1];
  if (!entry) return Promise.reject(new Error("Không xác định được CLI entrypoint."));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, entry, ...args], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer) => {
      if (output.length < 48_000) output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", reject);
    child.once("close", (code) => resolve(`${output}\n[agent-team exit code: ${code ?? "unknown"}]`));
  });
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} phải là chuỗi không rỗng.`);
  return value.trim();
}

function isAbsolutePath(value: string): boolean {
  return process.platform === "win32" ? /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\") : value.startsWith("/");
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
