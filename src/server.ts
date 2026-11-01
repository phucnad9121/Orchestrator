import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { AgentRole, TeamMessage } from "./types.js";
import { AGENT_ROLES } from "./types.js";
import { pendingApprovals, resolveApproval } from "./core/approvals.js";
import { listRuns, loadRun, resolveRunDir, saveRun } from "./core/state.js";
import { runsRoot } from "./config.js";
import { errorMessage } from "./util/errors.js";
import { pathExists, readJson } from "./util/fsx.js";

export interface RunServerOptions {
  runId?: string;
  port: number;
  host?: string;
}

export interface RunServer {
  server: http.Server;
  url: string;
  runId: string;
  runDir: string;
}

// Dashboard chạy same-origin. Không bật CORS wildcard vì server không có auth
// và có endpoint POST duyệt approval.
const BASE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Khởi động dashboard read-only + SSE. Đây là server local, không có auth;
 * mặc định chỉ bind 127.0.0.1. Không tự chạy agent/resume — chỉ xem trạng thái,
 * sự kiện, báo cáo và duyệt/từ chối approval.
 */
export async function startRunServer(options: RunServerOptions): Promise<RunServer> {
  const host = options.host ?? "127.0.0.1";
  const runDir = resolveServerRunDir(options.runId);
  const state = loadRun(runDir);
  const runId = state.id;

  const server = http.createServer((req, res) => {
    handleRequest(req, res, runId, runDir).catch((error: unknown) => {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          // Kết nối đã đóng.
        }
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      sendJson(res, status, { ok: false, error: errorMessage(error) });
    });
  });
  // SSE giữ kết nối lâu; tránh Node tự cắt request.
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, host);
  });

  const address = server.address() as AddressInfo | string | null;
  const actualPort = typeof address === "object" && address ? address.port : options.port;
  const displayHost =
    host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return {
    server,
    url: `http://${displayHost}:${actualPort}/`,
    runId,
    runDir,
  };
}

export async function serveRun(options: RunServerOptions): Promise<void> {
  const started = await startRunServer(options);
  console.log("");
  console.log("🌐 Agent Team dashboard");
  console.log(`   URL:      ${started.url}`);
  console.log(`   Run:      ${started.runId}`);
  console.log(`   Run dir:  ${started.runDir}`);
  console.log("   Ctrl+C để dừng server.");
  console.log("");

  await new Promise<void>((resolve) => {
    let stopping = false;
    const shutdown = (): void => {
      if (stopping) return;
      stopping = true;
      started.server.closeAllConnections?.();
      started.server.close(() => resolve());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  defaultRunId: string,
  defaultRunDir: string,
): Promise<void> {
  if (req.method === "OPTIONS") {
    res.writeHead(204, BASE_HEADERS);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const parts = url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => safeDecode(part));

  if (req.method === "GET" && (parts.length === 0 || parts[0] === "index.html")) {
    sendHtml(res, dashboardHtml(defaultRunId));
    return;
  }
  if (req.method === "GET" && parts[0] === "health") {
    const state = loadRun(defaultRunDir);
    sendJson(res, 200, {
      ok: true,
      runId: state.id,
      status: state.status,
      phase: state.phase,
      tasks: state.tasks.length,
    });
    return;
  }
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "runs" && parts.length === 2) {
    sendJson(res, 200, {
      runs: listRuns(runsRoot()).map((run) => ({
        id: run.id,
        status: run.status,
        request: run.request,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        taskCount: run.taskCount,
        doneCount: run.doneCount,
      })),
    });
    return;
  }

  if (parts[0] !== "api" || parts[1] !== "runs" || !parts[2]) {
    throw new HttpError(404, "Không tìm thấy endpoint.");
  }
  const runId = parts[2];
  const runDir = resolveServerRunDir(runId);

  if (req.method === "GET" && parts.length === 3) {
    sendJson(res, 200, loadRun(runDir));
    return;
  }
  if (req.method === "GET" && parts[3] === "state" && parts.length === 4) {
    sendJson(res, 200, loadRun(runDir));
    return;
  }
  if (req.method === "GET" && parts[3] === "events" && parts.length === 4) {
    streamEvents(req, res, runDir);
    return;
  }
  if (req.method === "GET" && parts[3] === "report" && parts.length === 4) {
    sendFileOr404(res, path.join(runDir, "report.md"), "text/markdown; charset=utf-8");
    return;
  }
  if (req.method === "GET" && parts[3] === "summary" && parts.length === 4) {
    sendFileOr404(res, path.join(runDir, "summary.json"), "application/json; charset=utf-8");
    return;
  }
  if (req.method === "GET" && parts[3] === "messages" && parts.length === 4) {
    const messages = safeReadJson<TeamMessage[]>(path.join(runDir, "messages.json")) ?? [];
    sendJson(res, 200, { messages });
    return;
  }
  if (req.method === "GET" && parts[3] === "approvals" && parts.length === 4) {
    const state = loadRun(runDir);
    sendJson(res, 200, {
      approvals: state.approvals,
      pending: pendingApprovals(state),
    });
    return;
  }
  if (req.method === "GET" && parts[3] === "agents" && parts.length === 4) {
    sendJson(res, 200, { agents: agentReports(runDir) });
    return;
  }
  if (
    req.method === "GET" &&
    parts[3] === "agents" &&
    parts[4] &&
    AGENT_ROLES.includes(parts[4] as AgentRole) &&
    parts.length === 5
  ) {
    sendFileOr404(
      res,
      path.join(runDir, "agents", `${parts[4]}.md`),
      "text/markdown; charset=utf-8",
    );
    return;
  }
  if (req.method === "POST" && parts[3] === "approvals" && parts[4] && parts[5]) {
    await handleApproval(req, res, runId, runDir, parts[4], parts[5]);
    return;
  }

  throw new HttpError(404, "Không tìm thấy endpoint.");
}

async function handleApproval(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
  runDir: string,
  approvalId: string,
  action: string,
): Promise<void> {
  if (action !== "approve" && action !== "reject") {
    throw new HttpError(404, `Hành động approval không hợp lệ: ${action}`);
  }
  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.includes("application/json")) {
    throw new HttpError(415, "Content-Type phải là application/json.");
  }
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) {
        throw new HttpError(403, "Origin không khớp host của dashboard.");
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(403, "Origin không hợp lệ.");
    }
  }
  const rawBody = await readBody(req);
  let reason: string | undefined;
  if (rawBody.trim()) {
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new HttpError(400, "Body phải là JSON hợp lệ.");
    }
    if (payload && typeof payload === "object" && "reason" in payload) {
      reason = String((payload as { reason?: unknown }).reason ?? "") || undefined;
    }
  }

  const state = loadRun(runDir);
  let resolved;
  try {
    resolved = resolveApproval(
      state,
      approvalId,
      action === "approve" ? "approved" : "rejected",
      reason ?? (action === "approve" ? "Phê duyệt qua dashboard" : "Từ chối qua dashboard"),
    );
  } catch (error) {
    throw new HttpError(404, errorMessage(error));
  }
  saveRun(state, runDir);
  sendJson(res, 200, {
    ok: true,
    runId,
    approvals: resolved,
    hint:
      state.status === "awaiting_approval"
        ? `Chạy: npm run agent -- resume ${runId}`
        : "Trạng thái approval đã được cập nhật.",
  });
}

function streamEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runDir: string,
): void {
  const file = path.join(runDir, "events.jsonl");
  res.writeHead(200, {
    ...BASE_HEADERS,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.setTimeout(0);
  res.flushHeaders?.();
  res.write("retry: 3000\n\n");
  res.write(`event: ready\ndata: ${JSON.stringify({ runId: path.basename(runDir) })}\n\n`);

  let offset = 0;
  let pending = "";
  let ticks = 0;
  let closed = false;

  const readNew = (): void => {
    if (closed) return;
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size < offset) {
      offset = 0;
      pending = "";
    }
    if (size === offset) return;

    const length = size - offset;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buffer, 0, length, offset);
    } finally {
      fs.closeSync(fd);
    }
    offset = size;

    pending += buffer.toString("utf8");
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      res.write(`event: log\ndata: ${line}\n\n`);
    }
  };

  readNew();
  const timer = setInterval(() => {
    readNew();
    ticks += 1;
    if (ticks % 30 === 0) res.write(": ping\n\n");
  }, 500);

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
  };
  req.on("close", close);
  req.on("aborted", close);
  res.on("close", close);
}

function sendFileOr404(res: http.ServerResponse, file: string, contentType: string): void {
  if (!pathExists(file)) throw new HttpError(404, `Không tìm thấy file: ${path.basename(file)}`);
  res.writeHead(200, {
    ...BASE_HEADERS,
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(fs.readFileSync(file));
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    ...BASE_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
}

function sendHtml(res: http.ServerResponse, html: string): void {
  res.writeHead(200, {
    ...BASE_HEADERS,
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveServerRunDir(runIdOrLatest?: string): string {
  const runId = runIdOrLatest?.trim();
  if (
    runId &&
    runId !== "latest" &&
    (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId === "." || runId === "..")
  ) {
    throw new HttpError(400, `Run ID không hợp lệ: ${runId}`);
  }
  try {
    return resolveRunDir(runsRoot(), runId || "latest");
  } catch (error) {
    throw new HttpError(404, errorMessage(error));
  }
}

function safeReadJson<T>(file: string): T | undefined {
  try {
    return readJson<T>(file);
  } catch {
    return undefined;
  }
}

function agentReports(runDir: string): Array<{ role: AgentRole; url: string; exists: boolean }> {
  return AGENT_ROLES.map((role) => ({
    role,
    url: `/api/runs/${encodeURIComponent(path.basename(runDir))}/agents/${role}`,
    exists: pathExists(path.join(runDir, "agents", `${role}.md`)),
  }));
}

function readBody(req: http.IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, "Body quá lớn."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function dashboardHtml(runId: string): string {
  const embeddedRunId = JSON.stringify(runId).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Team · ${escapeHtml(runId)}</title>
  <style>
    :root { color-scheme: dark; --bg:#0b1020; --panel:#121a2e; --line:#26324e; --text:#e6edf7; --muted:#8ea0bd; --accent:#5eead4; --warn:#fbbf24; --bad:#fb7185; --ok:#4ade80; }
    * { box-sizing: border-box; }
    body { margin:0; font:14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background:radial-gradient(1200px 600px at 10% -10%, #1d2b4f 0, var(--bg) 55%); color:var(--text); }
    header { padding:20px 24px; border-bottom:1px solid var(--line); display:flex; gap:16px; align-items:center; justify-content:space-between; flex-wrap:wrap; }
    h1 { font-size:18px; margin:0; letter-spacing:.2px; }
    h2 { font-size:13px; text-transform:uppercase; letter-spacing:.12em; color:var(--muted); margin:0 0 10px; }
    main { display:grid; grid-template-columns:minmax(0,1.35fr) minmax(320px,.65fr); gap:16px; padding:16px 24px 40px; }
    section { background:linear-gradient(180deg, rgba(255,255,255,.03), transparent), var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px; min-width:0; }
    section.wide { grid-column:1 / -1; }
    .muted { color:var(--muted); }
    .pill { display:inline-block; padding:2px 8px; border-radius:999px; border:1px solid var(--line); background:#0d1528; font-size:12px; }
    .pill.ok { color:var(--ok); border-color:#1d5a3a; }
    .pill.warn { color:var(--warn); border-color:#6b4d14; }
    .pill.bad { color:var(--bad); border-color:#6b2330; }
    .status-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }
    .stat { background:#0d1528; border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
    .stat b { display:block; font-size:18px; margin-top:2px; }
    #log { margin:0; height:360px; overflow:auto; white-space:pre-wrap; word-break:break-word; font:12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; background:#070c18; border:1px solid var(--line); border-radius:10px; padding:12px; }
    table { width:100%; border-collapse:collapse; font-size:12.5px; }
    th, td { text-align:left; border-bottom:1px solid var(--line); padding:7px 6px; vertical-align:top; }
    th { color:var(--muted); font-weight:600; }
    .row { border:1px solid var(--line); background:#0d1528; border-radius:10px; padding:10px 12px; margin-bottom:8px; }
    .row-head { display:flex; gap:8px; align-items:center; justify-content:space-between; flex-wrap:wrap; }
    .actions { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
    button { cursor:pointer; border:1px solid var(--line); background:#17213a; color:var(--text); border-radius:8px; padding:6px 10px; font:inherit; }
    button:hover { border-color:var(--accent); }
    button.approve { border-color:#1d5a3a; color:#b9f6d3; }
    button.reject { border-color:#6b2330; color:#ffc4cc; }
    a { color:var(--accent); }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
    .messages { max-height:300px; overflow:auto; }
    .msg { border-bottom:1px solid var(--line); padding:8px 0; }
    .msg:last-child { border-bottom:0; }
    @media (max-width:900px) { main { grid-template-columns:1fr; } section.wide { grid-column:auto; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>🤖 Agent Team · <span id="run-id"></span></h1>
      <div class="muted" id="run-request"></div>
    </div>
    <div class="toolbar">
      <span class="pill" id="connection">Đang kết nối…</span>
      <a href="/api/runs/${encodeURIComponent(runId)}/report" target="_blank" rel="noreferrer">Báo cáo</a>
      <a href="/api/runs/${encodeURIComponent(runId)}/summary" target="_blank" rel="noreferrer">JSON</a>
    </div>
  </header>
  <main>
    <section class="wide">
      <h2>Tổng quan</h2>
      <div class="status-grid" id="status"></div>
    </section>
    <section class="wide">
      <h2>Luồng sự kiện realtime</h2>
      <pre id="log">(đang tải…)</pre>
    </section>
    <section>
      <h2>Task</h2>
      <div id="tasks" class="muted">(đang tải…)</div>
    </section>
    <section>
      <h2>Approval đang chờ</h2>
      <div id="approvals" class="muted">(đang tải…)</div>
      <div class="muted" style="margin-top:10px">Duyệt xong cần chạy <code>npm run agent -- resume &lt;runId&gt;</code>.</div>
    </section>
    <section>
      <h2>Báo cáo riêng theo agent</h2>
      <div id="agents" class="muted">(đang tải…)</div>
    </section>
    <section>
      <h2>Tin nhắn đội</h2>
      <div id="messages" class="messages muted">(đang tải…)</div>
    </section>
  </main>
  <script>
    const RUN_ID = ${embeddedRunId};
    const API = '/api/runs/' + encodeURIComponent(RUN_ID);
    const logEl = document.getElementById('log');
    const statusEl = document.getElementById('status');
    const tasksEl = document.getElementById('tasks');
    const approvalsEl = document.getElementById('approvals');
    const agentsEl = document.getElementById('agents');
    const messagesEl = document.getElementById('messages');
    const connectionEl = document.getElementById('connection');
    const runIdEl = document.getElementById('run-id');
    const requestEl = document.getElementById('run-request');
    runIdEl.textContent = RUN_ID;

    function make(tag, text, className) {
      const el = document.createElement(tag);
      if (text !== undefined && text !== null) el.textContent = String(text);
      if (className) el.className = className;
      return el;
    }
    function statusClass(value) {
      if (value === 'completed' || value === 'done') return 'pill ok';
      if (value === 'awaiting_approval' || value === 'needs_approval' || value === 'running') return 'pill warn';
      if (value === 'failed' || value === 'blocked') return 'pill bad';
      return 'pill';
    }
    function appendLog(line) {
      if (!line) return;
      let text = line;
      try {
        const ev = JSON.parse(line);
        if (ev && ev.event) text = (ev.ts || '') + ' [' + (ev.level || 'info') + '] ' + ev.event + ' — ' + (ev.message || '');
      } catch {}
      if (logEl.textContent === '(đang tải…)') logEl.textContent = '';
      logEl.textContent += text + '\\n';
      if (logEl.textContent.length > 250000) logEl.textContent = logEl.textContent.slice(-180000);
      logEl.scrollTop = logEl.scrollHeight;
    }
    function stat(label, value, cls) {
      const box = make('div', undefined, 'stat');
      box.appendChild(make('span', label, 'muted'));
      box.appendChild(make('b', value, cls));
      return box;
    }
    function renderState(state) {
      requestEl.textContent = state.request || '';
      statusEl.replaceChildren();
      const done = (state.tasks || []).filter(t => t.status === 'done').length;
      statusEl.appendChild(stat('Trạng thái', state.status, statusClass(state.status).replace('pill', '').trim()));
      statusEl.appendChild(stat('Phase', state.phase || '—'));
      statusEl.appendChild(stat('Task', done + '/' + (state.tasks || []).length));
      statusEl.appendChild(stat('Quality', state.quality && state.quality.passed === undefined ? 'chưa chạy' : state.quality && state.quality.passed ? 'ĐẠT' : 'CHƯA ĐẠT'));
      statusEl.appendChild(stat('Approval chờ', (state.approvals || []).filter(a => a.status === 'pending').length));
      statusEl.appendChild(stat('LLM calls', state.usage ? state.usage.calls : 0));

      tasksEl.replaceChildren();
      if (!state.tasks || state.tasks.length === 0) {
        tasksEl.textContent = '(chưa có task)';
      } else {
        const table = make('table');
        const head = make('tr');
        ['Task', 'Agent', 'Trạng thái', 'Kết quả'].forEach(h => head.appendChild(make('th', h)));
        table.appendChild(head);
        state.tasks.forEach(t => {
          const tr = make('tr');
          tr.appendChild(make('td', t.id + ' · ' + t.title));
          tr.appendChild(make('td', t.role));
          const statusTd = make('td');
          statusTd.appendChild(make('span', t.status, statusClass(t.status)));
          tr.appendChild(statusTd);
          tr.appendChild(make('td', (t.result && t.result.summary) || t.error || '—'));
          table.appendChild(tr);
        });
        tasksEl.appendChild(table);
      }

      approvalsEl.replaceChildren();
      const pending = (state.approvals || []).filter(a => a.status === 'pending');
      if (pending.length === 0) {
        approvalsEl.textContent = 'Không có approval đang chờ.';
      } else {
        pending.forEach(a => {
          const row = make('div', undefined, 'row');
          const head = make('div', undefined, 'row-head');
          head.appendChild(make('b', a.summary || a.id));
          head.appendChild(make('span', a.taskId, 'muted'));
          row.appendChild(head);
          row.appendChild(make('div', a.reason || '', 'muted'));
          const actions = make('div', undefined, 'actions');
          const approve = make('button', 'Duyệt', 'approve');
          const reject = make('button', 'Từ chối', 'reject');
          approve.onclick = () => decide(a.id, 'approve');
          reject.onclick = () => decide(a.id, 'reject');
          actions.appendChild(approve);
          actions.appendChild(reject);
          row.appendChild(actions);
          approvalsEl.appendChild(row);
        });
      }
    }
    async function refresh() {
      try {
        const stateRes = await fetch(API + '/state', { cache: 'no-store' });
        if (stateRes.ok) renderState(await stateRes.json());
      } catch (error) {
        connectionEl.textContent = 'Mất kết nối state';
        connectionEl.className = 'pill bad';
      }
      try {
        const msgRes = await fetch(API + '/messages', { cache: 'no-store' });
        const payload = msgRes.ok ? await msgRes.json() : { messages: [] };
        const messages = Array.isArray(payload.messages) ? payload.messages.slice(-30).reverse() : [];
        messagesEl.replaceChildren();
        if (messages.length === 0) messagesEl.textContent = 'Chưa có tin nhắn.';
        messages.forEach(m => {
          const row = make('div', undefined, 'msg');
          const head = make('div');
          head.appendChild(make('b', m.from + ' → ' + m.to));
          head.appendChild(document.createTextNode(' · ' + (m.createdAt || '')));
          row.appendChild(head);
          row.appendChild(make('div', m.subject || ''));
          row.appendChild(make('div', m.body || '', 'muted'));
          messagesEl.appendChild(row);
        });
      } catch {}
      try {
        const agentRes = await fetch(API + '/agents', { cache: 'no-store' });
        const payload = agentRes.ok ? await agentRes.json() : { agents: [] };
        agentsEl.replaceChildren();
        const list = Array.isArray(payload.agents) ? payload.agents : [];
        if (list.length === 0) agentsEl.textContent = 'Chưa có báo cáo agent.';
        list.forEach(a => {
          const link = make('a', a.role + (a.exists ? '' : ' (chưa có)'));
          link.href = a.url;
          link.target = '_blank';
          link.rel = 'noreferrer';
          agentsEl.appendChild(link);
          agentsEl.appendChild(make('br'));
        });
      } catch {}
    }
    async function decide(id, action) {
      try {
        const res = await fetch(API + '/approvals/' + encodeURIComponent(id) + '/' + action, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: action === 'approve' ? 'Phê duyệt qua dashboard' : 'Từ chối qua dashboard' }),
        });
        const payload = await res.json().catch(() => ({}));
        appendLog(JSON.stringify({ ts: new Date().toISOString(), level: res.ok ? 'success' : 'error', event: 'approval.' + action, message: payload.hint || payload.error || id }));
        await refresh();
      } catch (error) {
        appendLog('Lỗi gọi approval: ' + error);
      }
    }

    const source = new EventSource(API + '/events');
    source.addEventListener('ready', () => {
      logEl.textContent = '';
      connectionEl.textContent = 'SSE đã kết nối';
      connectionEl.className = 'pill ok';
    });
    source.addEventListener('log', event => appendLog(event.data));
    source.onerror = () => {
      connectionEl.textContent = 'SSE đang kết nối lại…';
      connectionEl.className = 'pill warn';
    };

    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
