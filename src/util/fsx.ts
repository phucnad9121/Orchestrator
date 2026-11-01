import fs from "node:fs";
import path from "node:path";
import { formatBytes } from "./text.js";

export function pathExists(target: string): boolean {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function atomicWriteFile(file: string, content: string | Buffer): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.copyFileSync(tmp, file);
    fs.rmSync(tmp, { force: true });
  }
}

export function writeJson(file: string, value: unknown): void {
  atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson<T>(file: string): T | undefined {
  if (!pathExists(file)) return undefined;
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw) as T;
}

export function readJsonStrict<T>(file: string, label: string): T {
  if (!pathExists(file)) throw new Error(`Không tìm thấy ${label}: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    throw new Error(`Không đọc được ${label} (${file}): ${(error as Error).message}`);
  }
}

export function readTextFile(file: string, maxBytes = 512_000): {
  text: string;
  size: number;
  truncated: boolean;
  binary: boolean;
} {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`Không phải file: ${file}`);
  const size = stat.size;
  const length = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buffer, 0, length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  const binary = sample.includes(0);
  return {
    text: binary ? "" : buffer.toString("utf8").replace(/^\uFEFF/, ""),
    size,
    truncated: size > maxBytes,
    binary,
  };
}

export function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

export function normalizeRelative(value: string): string {
  let result = toPosix(path.normalize(value));
  while (result.startsWith("./")) result = result.slice(2);
  return result === "" ? "." : result;
}

/** child có nằm trong parent (hoặc chính parent) không. */
export function isSubPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  if (relative === "") return true;
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    return false;
  }
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Chuyển glob đơn giản sang regex: **, *, ?.
 * Hỗ trợ "**\/*.java", "docs/**", ".env", "src/*.ts".
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = toPosix(glob).replace(/^\.\//, "");
  if (pattern.endsWith("/")) pattern += "**";
  let regex = "";
  for (let index = 0; index < pattern.length; ) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          regex += "(?:.*/)?";
          index += 3;
        } else {
          regex += ".*";
          index += 2;
        }
      } else {
        regex += "[^/]*";
        index += 1;
      }
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      index += 1;
      continue;
    }
    regex += escapeRegExp(char ?? "");
    index += 1;
  }
  return new RegExp(`^${regex}$`, process.platform === "win32" ? "i" : "");
}

export function matchesGlob(relativePath: string, glob: string): boolean {
  return globToRegExp(glob).test(normalizeRelative(relativePath));
}

export function matchesAnyGlob(relativePath: string, globs: string[]): boolean {
  return globs.some((glob) => matchesGlob(relativePath, glob));
}

export interface WalkOptions {
  excludeDirs?: Iterable<string>;
  maxDepth?: number;
  maxFiles?: number;
  include?: (relativePath: string) => boolean;
}

export function walkFiles(root: string, options: WalkOptions = {}): string[] {
  const exclude = new Set(options.excludeDirs ?? []);
  const maxDepth = options.maxDepth ?? 10;
  const maxFiles = options.maxFiles ?? 5000;
  const result: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (stack.length > 0 && result.length < maxFiles) {
    const current = stack.pop();
    if (!current) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(current.dir, entry.name);
      const relative = normalizeRelative(path.relative(root, absolute));
      if (entry.isDirectory()) {
        if (exclude.has(entry.name)) continue;
        if (entry.name === ".git") continue;
        if (current.depth + 1 > maxDepth) continue;
        stack.push({ dir: absolute, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (options.include && !options.include(relative)) continue;
      result.push(relative);
      if (result.length >= maxFiles) break;
    }
  }
  return result.sort((a, b) => a.localeCompare(b));
}

export function describeFile(absolute: string): string {
  try {
    const stat = fs.statSync(absolute);
    return `${formatBytes(stat.size)}`;
  } catch {
    return "?";
  }
}

export function rmrf(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

export function copyDirectory(source: string, target: string): void {
  fs.cpSync(source, target, { recursive: true });
}
