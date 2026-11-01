import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRunState, listRuns, loadRun, prepareRunDir, saveRun, writeRequest } from "../src/core/state.js";
import { getGitInfo } from "../src/core/git.js";
import { tempWorkspace } from "./helpers.js";

describe("run state", () => {
  it("lưu, đọc và liệt kê run", () => {
    const workspace = tempWorkspace({ files: { "README.md": "# test" } });
    try {
      const state = createRunState({
        request: "Yêu cầu test",
        workspace: workspace.dir,
        mode: "mock",
        git: getGitInfo(workspace.dir),
        maxFixCycles: 2,
      });
      const runDir = path.join(workspace.dir, "runs", state.id);
      prepareRunDir(runDir);
      writeRequest(runDir, state.request, { safe: true });
      saveRun(state, runDir);

      expect(fs.existsSync(path.join(runDir, "state.json"))).toBe(true);
      expect(fs.existsSync(path.join(runDir, "request.md"))).toBe(true);

      const loaded = loadRun(runDir);
      expect(loaded.id).toBe(state.id);
      expect(loaded.request).toBe("Yêu cầu test");
      expect(loaded.quality.maxCycles).toBe(2);

      const runs = listRuns(path.join(workspace.dir, "runs"));
      expect(runs).toHaveLength(1);
      expect(runs[0]?.id).toBe(state.id);
    } finally {
      workspace.cleanup();
    }
  });
});
