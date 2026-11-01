import fs from "node:fs";
import path from "node:path";
import type { AgentConfig } from "../types.js";
import { pathExists, readTextFile, walkFiles, matchesAnyGlob } from "../util/fsx.js";
import { truncate } from "../util/text.js";
import { getGitInfo, recentCommits } from "./git.js";

/**
 * Tạo "bản đồ repo" ngắn gọn để đưa vào prompt.
 * Không chứa secret; agent vẫn phải dùng tool để đọc chi tiết.
 */
export function buildRepoProfile(workspace: string, config: AgentConfig): string {
  const sections: string[] = [];
  const git = getGitInfo(workspace);

  sections.push(
    [
      "## Git",
      `- Repo: ${git.isRepo ? "có" : "không"}`,
      `- Branch: ${git.branch ?? "—"} · Commit: ${git.commit ?? "—"}`,
      `- Trạng thái đầu run: ${git.dirtyAtStart ? "có thay đổi chưa commit" : "sạch"}`,
    ].join("\n"),
  );

  const commits = recentCommits(workspace, 5);
  if (commits.length > 0) {
    sections.push(`### Commit gần đây\n${commits.map((line) => `- ${line}`).join("\n")}`);
  }

  const files = walkFiles(workspace, {
    excludeDirs: config.workspace.excludeDirs,
    maxDepth: 2,
    maxFiles: 250,
  }).filter((file) => !matchesAnyGlob(file, config.workspace.protectedPaths));
  const structure = files.slice(0, 180);
  sections.push(
    `### Cấu trúc (depth ≤ 2, tối đa 180 mục)\n\`\`\`\n${structure.join("\n")}${
      files.length > structure.length ? "\n…" : ""
    }\n\`\`\``,
  );

  const manifests: string[] = [];
  const pom = readIfExists(path.join(workspace, "backend", "pom.xml"), 120_000);
  if (pom) {
    manifests.push(`#### backend/pom.xml\n\`\`\`\n${summarizePom(pom)}\n\`\`\``);
  }
  const pkg = readIfExists(path.join(workspace, "frontend", "package.json"), 60_000);
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg) as {
        name?: string;
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      manifests.push(
        [
          "#### frontend/package.json",
          `- name: ${parsed.name ?? "—"}`,
          `- scripts: ${Object.entries(parsed.scripts ?? {}).map(([key, value]) => `${key}="${value}"`).join(", ") || "—"}`,
          `- dependencies: ${Object.keys(parsed.dependencies ?? {}).join(", ") || "—"}`,
          `- devDependencies: ${Object.keys(parsed.devDependencies ?? {}).join(", ") || "—"}`,
        ].join("\n"),
      );
    } catch {
      manifests.push("#### frontend/package.json\n(không parse được JSON)");
    }
  }
  if (manifests.length > 0) sections.push(`### Manifest\n${manifests.join("\n\n")}`);

  const specs = listSpecs(workspace);
  if (specs.length > 0) {
    sections.push(`### Specs hiện có (${specs.length})\n${specs.map((spec) => `- ${spec}`).join("\n")}`);
  }

  const constitution = readIfExists(path.join(workspace, ".specify", "memory", "constitution.md"), 120_000);
  if (constitution) {
    sections.push(
      `### Constitution (trích)\n${truncate(constitution.replace(/\r/g, ""), 1600)}`,
    );
  }

  const readme = readIfExists(path.join(workspace, "Readme.md"), 120_000)
    ?? readIfExists(path.join(workspace, "README.md"), 120_000);
  if (readme) {
    sections.push(`### README (trích)\n${truncate(readme.replace(/\r/g, ""), 1000)}`);
  }

  sections.push(
    [
      "### Lệnh kiểm thử đã cấu hình",
      ...Object.entries(config.tests).map(
        ([name, suite]) => `- ${name}: \`${suite.command}\` (cwd: ${suite.cwd})`,
      ),
    ].join("\n"),
  );

  const profile = sections.join("\n\n");
  return truncate(profile, config.limits.maxContextChars, "\n… [repo profile đã cắt bớt]");
}

function readIfExists(file: string, maxBytes: number): string | null {
  if (!pathExists(file)) return null;
  try {
    const result = readTextFile(file, maxBytes);
    return result.binary ? null : result.text;
  } catch {
    return null;
  }
}

function summarizePom(xml: string): string {
  const lines: string[] = [];
  const parent = /<parent>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?<version>([^<]+)<\/version>[\s\S]*?<\/parent>/.exec(xml);
  if (parent) lines.push(`- parent: ${parent[1]} ${parent[2]}`);
  const javaVersion = /<java\.version>([^<]+)<\/java\.version>/.exec(xml);
  if (javaVersion) lines.push(`- java.version: ${javaVersion[1]}`);
  const artifact = /<artifactId>([^<]+)<\/artifactId>/.exec(xml);
  if (artifact) lines.push(`- artifact: ${artifact[1]}`);
  const dependencies = [...xml.matchAll(/<dependency>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?<\/dependency>/g)]
    .map((match) => match[1])
    .filter(Boolean);
  lines.push(`- dependencies (${dependencies.length}): ${dependencies.slice(0, 30).join(", ")}`);
  return lines.join("\n");
}

function listSpecs(workspace: string): string[] {
  const dir = path.join(workspace, "specs");
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
