import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { buildPiCommand, childControlEventTool, childControlExtensionPath, inheritedExtensionPathsFromEnv, inheritedExtensionsEnv, writeLaunchLog } from "../src/piHarness.js";

test("buildPiCommand disables ambient context and allows only the control tool when no user tools are declared", () => {
  const command = buildPiCommand({
    systemPath: "/run/artifacts/system.md",
    taskPath: "/run/artifacts/task.md",
    runDir: "/run",
    cwd: "/repo",
    sessionPolicy: "record",
    piSessionPath: "/run/pi-session/session.jsonl",
    requestedPiSessionPath: "/run/pi-session/session.jsonl",
    userBuiltinTools: [],
    skills: [],
    extensions: [],
  });
  assert.equal(command.command, "pi");
  for (const flag of ["--session", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-extensions", "--append-system-prompt", "--system-prompt", "--tools"]) {
    assert.ok(command.args.includes(flag), `${flag} missing`);
  }
  assert.deepEqual(command.args.slice(command.args.indexOf("--session"), command.args.indexOf("--session") + 2), ["--session", "/run/pi-session/session.jsonl"]);
  assert.deepEqual(command.args.slice(command.args.indexOf("--append-system-prompt"), command.args.indexOf("--append-system-prompt") + 2), ["--append-system-prompt", ""]);
  assert.equal(command.args.includes("--no-tools"), false);
  assert.equal(command.args.includes("--no-session"), false);
  assert.deepEqual(command.args.slice(command.args.indexOf("--tools"), command.args.indexOf("--tools") + 2), ["--tools", childControlEventTool]);
  assert.ok(command.args.includes(childControlExtensionPath));
  assert.ok(command.args.includes("@/run/artifacts/task.md"));
  assert.equal(command.args.includes("--thinking"), false);
});

test("buildPiCommand supports explicit session opt-out", () => {
  const command = buildPiCommand({
    systemPath: "/run/artifacts/system.md",
    taskPath: "/run/artifacts/task.md",
    runDir: "/run",
    cwd: "/repo",
    sessionPolicy: "none",
    userBuiltinTools: [],
    skills: [],
    extensions: [],
  });
  assert.ok(command.args.includes("--no-session"));
  assert.equal(command.args.includes("--session"), false);
});

test("buildPiCommand passes declared tools, skills, extensions, model, and thinking level explicitly", () => {
  const command = buildPiCommand({
    systemPath: "/run/artifacts/system.md",
    taskPath: "/run/artifacts/task.md",
    runDir: "/run",
    cwd: "/repo",
    sessionPolicy: "record",
    piSessionPath: "/run/pi-session/session.jsonl",
    userBuiltinTools: ["read", "grep"],
    runtimeBuiltinTools: [childControlEventTool],
    runtimeExtensionPaths: [childControlExtensionPath],
    skills: ["repo-reader"],
    extensions: ["audit-extension"],
    model: "gpt-5.5",
    thinkingLevel: "high",
  });
  assert.equal(command.args.includes("--no-tools"), false);
  assert.deepEqual(command.args.slice(command.args.indexOf("--tools"), command.args.indexOf("--tools") + 2), ["--tools", `read,grep,${childControlEventTool}`]);
  assert.ok(command.args.includes("--skill"));
  assert.ok(command.args.includes("repo-reader"));
  assert.ok(command.args.includes("audit-extension"));
  assert.ok(command.args.includes("--model"));
  assert.ok(command.args.includes("gpt-5.5"));
  assert.deepEqual(command.args.slice(command.args.indexOf("--thinking"), command.args.indexOf("--thinking") + 2), ["--thinking", "high"]);
});

test("buildPiCommand loads inherited extensions before agent extensions", () => {
  const command = buildPiCommand({
    systemPath: "/run/artifacts/system.md",
    taskPath: "/run/artifacts/task.md",
    runDir: "/run",
    cwd: "/repo",
    sessionPolicy: "record",
    piSessionPath: "/run/pi-session/session.jsonl",
    userBuiltinTools: [],
    skills: [],
    inheritedExtensionPaths: ["/active/caveman/index.ts"],
    extensions: ["audit-extension"],
  });
  const extensions = command.args.flatMap((arg, index, args) => (arg === "-e" ? [args[index + 1]] : [])).filter((value): value is string => Boolean(value));
  assert.deepEqual(extensions, ["/active/caveman/index.ts", "audit-extension", childControlExtensionPath]);
});

test("inheritedExtensionPathsFromEnv parses path-delimited inherited extension env", () => {
  assert.deepEqual(inheritedExtensionPathsFromEnv({ [inheritedExtensionsEnv]: ["/a.ts", "/b.ts"].join(delimiter) } as NodeJS.ProcessEnv), ["/a.ts", "/b.ts"]);
});

test("writeLaunchLog redacts secret-like environment values", () => {
  const runDir = mkdtempSync(join(tmpdir(), "async-subagents-launch-"));
  const command = buildPiCommand({
    systemPath: "/run/artifacts/system.md",
    taskPath: "/run/artifacts/task.md",
    runDir,
    cwd: "/repo",
    sessionPolicy: "record",
    piSessionPath: join(runDir, "pi-session", "session.jsonl"),
    userBuiltinTools: [],
    skills: [],
    extensions: [],
    extraEnv: { API_TOKEN: "secret", NORMAL: "value" },
  });
  writeLaunchLog(runDir, command);
  const log = JSON.parse(readFileSync(join(runDir, "logs", "launch.json"), "utf8"));
  assert.equal(log.env.API_TOKEN, "<redacted>");
  assert.equal(log.env.NORMAL, "value");
});
