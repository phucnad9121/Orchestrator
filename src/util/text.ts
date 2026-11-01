import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export function makeRunId(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `run-${stamp}-${randomUUID().slice(0, 4)}`;
}

export function truncate(value: string, max: number, note = "\n… [đã cắt bớt]"): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - note.length)) + note;
}

/** Giữ phần cuối của output (thường chứa lỗi/build failure). */
export function tail(value: string, max: number): string {
  if (value.length <= max) return value;
  return "… [phần đầu đã cắt]\n" + value.slice(value.length - max);
}

export function stableHash(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return createHash("sha256").update(raw).digest("hex").slice(0, 20);
}

export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

/** Che các chuỗi giống secret trước khi ghi log/transcript. */
export function redactSecrets(value: string): string {
  return value
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, "Bearer [REDACTED_TOKEN]")
    .replace(
      /\b(api[_-]?key|secret|password|passwd|token)\b(\s*[:=]\s*)["']?[^\s"',}]{8,}/gi,
      "$1$2[REDACTED]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]");
}

export function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/api.?key|secret|password|token/i.test(key)) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactDeep(item);
      }
    }
    return result;
  }
  return value;
}

/**
 * Trích xuất JSON object đầu tiên hợp lệ từ câu trả lời của LLM.
 * Hỗ trợ fenced code block, JSON thuần và JSON lẫn văn xuôi.
 */
export function extractJsonObject(text: string): unknown | null {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(fenced)) {
    if (match[1]) candidates.push(match[1].trim());
  }
  candidates.push(text.trim());

  for (const candidate of candidates) {
    const direct = tryParse(candidate);
    if (direct !== null) return direct;
    const balanced = extractBalancedObjects(candidate);
    // Ưu tiên object xuất hiện sau cùng (thường là kết quả cuối).
    for (const snippet of balanced.reverse()) {
      const parsed = tryParse(snippet);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function tryParse(value: string): unknown | null {
  if (!value.startsWith("{") && !value.startsWith("[")) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function extractBalancedObjects(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}") {
      if (depth > 0) depth -= 1;
      if (depth === 0 && start >= 0) {
        found.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return found;
}

export function quoteForShell(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export function relativeTo(workspace: string, absolute: string): string {
  const relative = path.relative(workspace, absolute);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}
