import fs from "node:fs";
import path from "node:path";
import { classifyPath } from "../core/policy.js";
import { PolicyDeniedError } from "../util/errors.js";
import {
  matchesGlob,
  normalizeRelative,
  pathExists,
  readTextFile,
  toPosix,
  walkFiles,
} from "../util/fsx.js";
import { formatBytes, stableHash, truncate } from "../util/text.js";
import {
  optionalNumber,
  optionalString,
  requireString,
  type ToolContext,
  type ToolDefinition,
  type ToolOutput,
} from "./types.js";

export const fsTools: ToolDefinition[] = [
  {
    name: "fs_list",
    description:
      "Liệt kê file/thư mục trong workspace. Dùng để khám phá cấu trúc trước khi đọc/sửa.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Đường dẫn tương đối (mặc định '.')." },
        depth: { type: "integer", description: "Độ sâu tối đa 1-4 (mặc định 2)." },
      },
      required: [],
    },
    async execute(args, context) {
      return listTool(args, context);
    },
  },
  {
    name: "fs_read",
    description:
      "Đọc nội dung file text (có thể chọn khoảng dòng). Trả về nội dung gốc, không thêm số dòng.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Đường dẫn file tương đối với workspace." },
        startLine: { type: "integer", description: "Dòng bắt đầu (1-based, tuỳ chọn)." },
        endLine: { type: "integer", description: "Dòng kết thúc (1-based, tuỳ chọn)." },
      },
      required: ["path"],
    },
    async execute(args, context) {
      return readTool(args, context);
    },
  },
  {
    name: "fs_write",
    description:
      "Ghi toàn bộ nội dung file (tạo mới hoặc ghi đè). Chỉ dùng khi đã đọc file hiện có nếu file tồn tại.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Đường dẫn file tương đối với workspace." },
        content: { type: "string", description: "Toàn bộ nội dung mới." },
        reason: { type: "string", description: "Lý do thay đổi (ngắn gọn)." },
      },
      required: ["path", "content"],
    },
    async execute(args, context) {
      return writeTool(args, context);
    },
  },
  {
    name: "fs_edit",
    description:
      "Sửa chính xác một đoạn text trong file (oldText phải xuất hiện đúng 1 lần). An toàn hơn fs_write cho thay đổi nhỏ.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Đường dẫn file tương đối với workspace." },
        oldText: { type: "string", description: "Đoạn text gốc cần thay (đúng từng ký tự)." },
        newText: { type: "string", description: "Đoạn text thay thế." },
        reason: { type: "string", description: "Lý do thay đổi (ngắn gọn)." },
      },
      required: ["path", "oldText", "newText"],
    },
    async execute(args, context) {
      return editTool(args, context);
    },
  },
  {
    name: "fs_search",
    description:
      "Tìm kiếm regex trong file text của workspace. Trả về đường dẫn:dòng:nội dung (tối đa 120 kết quả).",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex cần tìm." },
        path: { type: "string", description: "Thư mục/file bắt đầu (mặc định '.')." },
        include: {
          type: "string",
          description: "Glob lọc file, ví dụ '*.java', 'src/**/*.ts' (tuỳ chọn).",
        },
        caseSensitive: { type: "boolean", description: "Phân biệt hoa thường (mặc định false)." },
      },
      required: ["pattern"],
    },
    async execute(args, context) {
      return searchTool(args, context);
    },
  },
];

function authorizePath(context: ToolContext, target: string, operation: "read" | "write"): string {
  const policy = classifyPath({
    workspace: context.workspace,
    target,
    operation,
    config: context.config,
  });
  const absolute = path.isAbsolute(target) ? path.resolve(target) : path.resolve(context.workspace, target);
  return absolute;
}

async function ensurePath(
  context: ToolContext,
  target: string,
  operation: "read" | "write",
  check: { tool: string; summary: string; detail: string; argsHash: string },
): Promise<{ absolute: string; relative: string }> {
  const absolute = authorizePath(context, target, operation);
  const policy = classifyPath({
    workspace: context.workspace,
    target: absolute,
    operation,
    config: context.config,
  });
  if (policy.decision === "deny") throw new PolicyDeniedError(policy.reason);
  if (policy.decision === "ask") {
    await context.approvals.authorize({
      taskId: context.task.id,
      role: context.role,
      tool: check.tool,
      argsHash: check.argsHash,
      summary: check.summary,
      detail: check.detail,
      policy,
    });
  }
  const relative = normalizeRelative(path.relative(context.workspace, absolute));
  return { absolute, relative };
}

async function listTool(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput> {
  const target = optionalString(args, "path") ?? ".";
  const depth = clamp(optionalNumber(args, "depth") ?? 2, 1, 4);
  const { absolute, relative } = await ensurePath(context, target, "read", {
    tool: "fs_list",
    summary: `Liệt kê ${target}`,
    detail: `path=${target}`,
    argsHash: stableHash({ op: "list", target }),
  });

  if (!pathExists(absolute)) return { ok: false, output: `Không tồn tại: ${relative}` };
  const stat = fs.statSync(absolute);
  if (stat.isFile()) {
    return {
      ok: true,
      output: `f ${relative} (${formatBytes(stat.size)})`,
    };
  }

  const exclude = new Set(context.config.workspace.excludeDirs);
  const lines: string[] = [];
  const visit = (dir: string, currentDepth: number): void => {
    if (currentDepth > depth || lines.length > 600) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (lines.length > 600) return;
      const child = path.join(dir, entry.name);
      const childRelative = toPosix(path.relative(context.workspace, child));
      const policy = classifyPath({
        workspace: context.workspace,
        target: child,
        operation: "read",
        config: context.config,
      });
      if (policy.decision === "deny") continue;
      if (entry.isDirectory()) {
        if (exclude.has(entry.name)) continue;
        lines.push(`d ${childRelative}/`);
        visit(child, currentDepth + 1);
      } else if (entry.isFile()) {
        try {
          lines.push(`f ${childRelative} (${formatBytes(fs.statSync(child).size)})`);
        } catch {
          lines.push(`f ${childRelative}`);
        }
      }
    }
  };
  visit(absolute, 1);
  return {
    ok: true,
    output: lines.length > 0 ? lines.join("\n") : `(thư mục rỗng: ${relative})`,
  };
}

async function readTool(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput> {
  const target = requireString(args, "path");
  const startLine = optionalNumber(args, "startLine");
  const endLine = optionalNumber(args, "endLine");
  const { absolute, relative } = await ensurePath(context, target, "read", {
    tool: "fs_read",
    summary: `Đọc ${target}`,
    detail: `path=${target}`,
    argsHash: stableHash({ op: "read", target }),
  });
  if (!pathExists(absolute)) return { ok: false, output: `Không tồn tại: ${relative}` };
  const result = readTextFile(absolute, 512_000);
  if (result.binary) return { ok: false, output: `File nhị phân, không đọc được: ${relative}` };

  const allLines = result.text.split("\n");
  const from = Math.max(1, Math.floor(startLine ?? 1));
  const to = Math.min(allLines.length, Math.floor(endLine ?? allLines.length));
  if (from > to) return { ok: false, output: `Khoảng dòng không hợp lệ: ${from}-${to}` };
  const slice = allLines.slice(from - 1, to).join("\n");
  const header = [
    `File: ${relative}`,
    `Tổng ${allLines.length} dòng · ${formatBytes(result.size)} · hiển thị dòng ${from}-${to}${
      result.truncated ? " · file bị cắt do quá lớn" : ""
    }`,
    "---",
  ].join("\n");
  return {
    ok: true,
    output: truncate(`${header}\n${slice}`, context.config.limits.maxToolOutputChars),
  };
}

async function writeTool(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput> {
  const target = requireString(args, "path");
  const content = requireString(args, "content", { allowEmpty: true });
  const reason = optionalString(args, "reason") ?? "(không ghi lý do)";
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > context.config.limits.maxFileWriteBytes) {
    return {
      ok: false,
      output: `Nội dung ${formatBytes(bytes)} vượt giới hạn ${formatBytes(
        context.config.limits.maxFileWriteBytes,
      )}. Hãy chia nhỏ thay đổi.`,
    };
  }
  const { absolute, relative } = await ensurePath(context, target, "write", {
    tool: "fs_write",
    summary: `Ghi file ${target}`,
    detail: `path=${target}\nbytes=${bytes}\nreason=${reason}`,
    argsHash: stableHash({ op: "write", target, content }),
  });

  let unchanged = false;
  if (pathExists(absolute)) {
    try {
      unchanged = fs.readFileSync(absolute, "utf8") === content;
    } catch {
      unchanged = false;
    }
  }
  if (!unchanged) {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, "utf8");
  }
  return {
    ok: true,
    output: unchanged
      ? `Không thay đổi (nội dung giống hệt): ${relative}`
      : `Đã ghi ${relative} (${formatBytes(bytes)}).`,
    meta: { filesChanged: unchanged ? [] : [relative] },
  };
}

async function editTool(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput> {
  const target = requireString(args, "path");
  const oldText = requireString(args, "oldText", { allowEmpty: false });
  const newText = requireString(args, "newText", { allowEmpty: true });
  const reason = optionalString(args, "reason") ?? "(không ghi lý do)";
  if (oldText === newText) return { ok: false, output: "oldText và newText giống nhau." };

  const { absolute, relative } = await ensurePath(context, target, "write", {
    tool: "fs_edit",
    summary: `Sửa file ${target}`,
    detail: `path=${target}\nreason=${reason}\noldText=${truncate(oldText, 600)}`,
    argsHash: stableHash({ op: "edit", target, oldText, newText }),
  });
  if (!pathExists(absolute)) return { ok: false, output: `Không tồn tại: ${relative}` };
  const current = fs.readFileSync(absolute, "utf8");
  const occurrences = countOccurrences(current, oldText);
  if (occurrences === 0) {
    return {
      ok: false,
      output: `Không tìm thấy oldText trong ${relative}. Hãy đọc lại file và cung cấp đoạn text chính xác (kể cả khoảng trắng).`,
    };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      output: `oldText xuất hiện ${occurrences} lần trong ${relative}. Cần thêm ngữ cảnh để chỉ khớp đúng 1 lần.`,
    };
  }
  fs.writeFileSync(absolute, current.replace(oldText, newText), "utf8");
  return {
    ok: true,
    output: `Đã sửa ${relative}.`,
    meta: { filesChanged: [relative] },
  };
}

async function searchTool(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput> {
  const pattern = requireString(args, "pattern", { maxLength: 500 });
  const target = optionalString(args, "path") ?? ".";
  const include = optionalString(args, "include");
  const caseSensitive = args.caseSensitive === true;
  const { absolute, relative } = await ensurePath(context, target, "read", {
    tool: "fs_search",
    summary: `Tìm "${pattern}" trong ${target}`,
    detail: `pattern=${pattern}\npath=${target}\ninclude=${include ?? "*"}`,
    argsHash: stableHash({ op: "search", pattern, target, include }),
  });
  if (!pathExists(absolute)) return { ok: false, output: `Không tồn tại: ${relative}` };

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseSensitive ? "" : "i");
  } catch {
    regex = new RegExp(escapeRegExp(pattern), caseSensitive ? "" : "i");
  }

  const root = fs.statSync(absolute).isDirectory() ? absolute : path.dirname(absolute);
  const files = fs.statSync(absolute).isFile()
    ? [relative]
    : walkFiles(root, {
        excludeDirs: context.config.workspace.excludeDirs,
        maxDepth: 12,
        maxFiles: 4000,
        include: include
          ? (candidate) => matchesGlob(candidate, include) || matchesGlob(path.basename(candidate), include)
          : undefined,
      }).map((candidate) => toPosix(path.relative(context.workspace, path.join(root, candidate))));

  const matches: string[] = [];
  for (const file of files) {
    if (matches.length >= 120) break;
    const fileAbsolute = path.join(context.workspace, file);
    const policy = classifyPath({
      workspace: context.workspace,
      target: fileAbsolute,
      operation: "read",
      config: context.config,
    });
    if (policy.decision === "deny") continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fileAbsolute);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > 1_200_000) continue;
    let content: string;
    try {
      const read = readTextFile(fileAbsolute, 1_200_000);
      if (read.binary) continue;
      content = read.text;
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (regex.test(lines[index] ?? "")) {
        matches.push(`${file}:${index + 1}: ${truncate((lines[index] ?? "").trim(), 240)}`);
        if (matches.length >= 120) break;
      }
    }
  }

  return {
    ok: true,
    output:
      matches.length > 0
        ? `${matches.length} kết quả:\n${matches.join("\n")}`
        : `Không tìm thấy "${pattern}" trong ${relative}.`,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}
