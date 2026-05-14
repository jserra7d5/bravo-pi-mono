import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPiCommand, childControlEventTool, childControlExtensionPath, writeLaunchLog } from "../src/piHarness.js";

test("buildPiCommand disables ambient context and allows only the control tool when no user tools are declared", () => {
  const command = buildPiCommand({
    systemPath: "/run/artifacts/system.md",
    taskPath: "/run/artifacts/task.md",
    runDir: "/run",
    cwd: "/repo",
    tools: [],
    skills: [],
    extensions: [],
  });
  assert.equal(command.command, "pi");
  for (const flag of ["--no-session", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-extensions", "--system-prompt", "--tools"]) {
    assert.ok(command.args.includes(flag), `${flag} missing`);
  }
  assert.equal(command.args.includes("--no-tools"), false);
  assert.deepEqual(command.args.slice(command.args.indexOf("--tools"), command.args.indexOf("--tools") + 2), ["--tools", childControlEventTool]);
  assert.ok(command.args.includes(childControlExtensionPath));
  assert.ok(command.args.includes("@/run/artifacts/task.md"));
});

test("buildPiCommand passes declared tools, skills, extensions, and model explicitly", () => {
  const command = buildPiCommand({
    systemPath: "/run/artifacts/system.md",
    taskPath: "/run/artifacts/task.md",
    runDir: "/run",
    cwd: "/repo",
    tools: ["read", "grep"],
    skills: ["repo-reader"],
    extensions: ["audit-extension"],
    model: "gpt-5.5",
  });
  assert.equal(command.args.includes("--no-tools"), false);
  assert.deepEqual(command.args.slice(command.args.indexOf("--tools"), command.args.indexOf("--tools") + 2), ["--tools", `read,grep,${childControlEventTool}`]);
  assert.ok(command.args.includes("--skill"));
  assert.ok(command.args.includes("repo-reader"));
  assert.ok(command.args.includes("audit-extension"));
  assert.ok(command.args.includes("--model"));
  assert.ok(command.args.includes("gpt-5.5"));
});

test("writeLaunchLog redacts secret-like environment values", () => {
  const runDir = mkdtempSync(join(tmpdir(), "async-subagents-launch-"));
  const command = buildPiCommand({
    systemPath: "/run/artifacts/system.md",
    taskPath: "/run/artifacts/task.md",
    runDir,
    cwd: "/repo",
    tools: [],
    skills: [],
    extensions: [],
    extraEnv: { API_TOKEN: "secret", NORMAL: "value" },
  });
  writeLaunchLog(runDir, command);
  const log = JSON.parse(readFileSync(join(runDir, "logs", "launch.json"), "utf8"));
  assert.equal(log.env.API_TOKEN, "<redacted>");
  assert.equal(log.env.NORMAL, "value");
});
