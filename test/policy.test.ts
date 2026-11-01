import { describe, expect, it } from "vitest";
import { classifyPath, classifyShell } from "../src/core/policy.js";
import { makeConfig } from "./helpers.js";

const config = makeConfig();
const workspace = "C:\\repo";

describe("classifyShell", () => {
  it("cho phép build/test thông thường", () => {
    expect(classifyShell("npm run build", config).decision).toBe("allow");
    expect(classifyShell("mvnw.cmd -q test", config).decision).toBe("allow");
    expect(classifyShell("git status --porcelain", config).decision).toBe("allow");
    expect(classifyShell("git diff --stat", config).decision).toBe("allow");
  });

  it("chặn lệnh phá huỷ", () => {
    expect(classifyShell("git push origin main", config).decision).toBe("deny");
    expect(classifyShell("git reset --hard HEAD", config).decision).toBe("deny");
    expect(classifyShell("rm -rf /", config).decision).toBe("deny");
    expect(classifyShell("node -e \"process.exit(1)\"", config).decision).toBe("deny");
    expect(classifyShell("npm run build && del file", config).decision).toBe("deny");
    expect(classifyShell("npm run build | more", config).decision).toBe("deny");
  });

  it("yêu cầu phê duyệt với thao tác đổi trạng thái", () => {
    expect(classifyShell("git commit -m test", config).decision).toBe("ask");
    expect(classifyShell("npm install", config).decision).toBe("ask");
    expect(classifyShell("npx cowsay hi", config).decision).toBe("ask");
  });

  it("yêu cầu phê duyệt với lệnh ngoài allowlist", () => {
    expect(classifyShell("curl https://example.com", config).decision).toBe("ask");
    expect(classifyShell("powershell -Command dir", config).decision).toBe("ask");
  });
});

describe("classifyPath", () => {
  it("cho phép file trong workspace", () => {
    expect(
      classifyPath({ workspace, target: "backend/src/Main.java", operation: "write", config }).decision,
    ).toBe("allow");
    expect(
      classifyPath({ workspace, target: "frontend/src/App.jsx", operation: "read", config }).decision,
    ).toBe("allow");
  });

  it("chặn path traversal và file ngoài workspace", () => {
    expect(
      classifyPath({ workspace, target: "..\\secret.txt", operation: "read", config }).decision,
    ).toBe("deny");
    expect(
      classifyPath({ workspace, target: "D:\\other\\file.txt", operation: "write", config }).decision,
    ).toBe("deny");
  });

  it("chặn secret và .git", () => {
    expect(classifyPath({ workspace, target: ".env", operation: "read", config }).decision).toBe("deny");
    expect(
      classifyPath({ workspace, target: "frontend/.env.local", operation: "read", config }).decision,
    ).toBe("deny");
    expect(classifyPath({ workspace, target: ".git/config", operation: "write", config }).decision).toBe(
      "deny",
    );
    expect(
      classifyPath({ workspace, target: "docs/Token.md", operation: "read", config }).decision,
    ).toBe("deny");
  });

  it("cho phép .env.example", () => {
    expect(
      classifyPath({ workspace, target: ".env.example", operation: "read", config }).decision,
    ).toBe("allow");
  });
});
