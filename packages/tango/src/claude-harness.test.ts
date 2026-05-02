import { describe, it } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeCommand } from "./harnesses/claude.js";
import type { AgentMetadata } from "./types.js";

function tempDir(prefix = "tango-claude-harness-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

describe("Claude harness", () => {
  it("executes CLAUDE_CODE_SHELL_PREFIX command strings while restoring the real HOME", () => {
    const root = tempDir();
    const cwd = join(root, "project");
    const runDir = join(root, "run");
    const homeDir = join(runDir, "home");
    const operatorHome = join(root, "operator-home");
    const systemFile = join(runDir, "system.md");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(operatorHome, { recursive: true });
    writeFileSync(systemFile, "system\n", "utf8");

    const previousHome = process.env.HOME;
    try {
      process.env.HOME = operatorHome;
      const meta: AgentMetadata = {
        name: "claude-wrapper-test",
        harness: "claude",
        mode: "interactive",
        status: "created",
        cwd,
        task: "test",
        runDir,
        homeDir,
        tmuxSocket: join(runDir, "tmux.sock"),
        tmuxSession: "tango",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      const command = buildClaudeCommand(meta, undefined, systemFile, "test");
      const wrapper = command.env.CLAUDE_CODE_SHELL_PREFIX;
      assert.ok(wrapper);
      assert.ok(existsSync(wrapper));

      const homeOut = join(root, "home.out");
      const cwdOut = join(root, "cwd.out");
      const commandString = `printf '%s' "$HOME" > ${shellQuote(homeOut)} && pwd -P >| ${shellQuote(cwdOut)}`;
      const result = spawnSync(wrapper, [commandString], { cwd, env: command.env, encoding: "utf8" });

      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.strictEqual(readFileSync(homeOut, "utf8"), operatorHome);
      assert.strictEqual(readFileSync(cwdOut, "utf8").trim(), cwd);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
