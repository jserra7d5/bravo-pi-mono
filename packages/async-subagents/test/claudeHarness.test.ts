import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { buildClaudeCommand, CLAUDE_CONSTANT_PROMPT, prepareClaudeHome, resolveClaudeModel } from "../src/claudeHarness.js";

function operatorHome(root: string): string {
  const home = join(root, "operator-home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "token" } }), "utf8");
  return home;
}

test("buildClaudeCommand constructs dangerous-auth non-bare Claude command", () => {
  const runDir = mkdtempSync(join(tmpdir(), "async-subagents-claude-command-"));
  const command = buildClaudeCommand({
    runDir,
    cwd: runDir,
    systemPath: join(runDir, "artifacts", "system.md"),
    displayName: "worker/claude",
    model: "claude-opus-4-8",
    effort: "max",
  });
  assert.equal(command.command, "claude");
  assert.equal(command.executionMode, "dangerous-auth");
  assert.equal(command.memoryIsolation, "best-effort-non-bare");
  assert.equal(command.args.includes("--bare"), false);
  for (const arg of ["--dangerously-skip-permissions", "--settings", "--setting-sources", "user", "--strict-mcp-config", "--mcp-config", "--disallowed-tools", "Task", "--model", "claude-opus-4-8", "--effort", "max", "--system-prompt-file"]) {
    assert.equal(command.args.includes(arg), true, arg);
  }
  assert.equal(command.args.at(-1), CLAUDE_CONSTANT_PROMPT);
  assert.equal(command.env.HOME, join(runDir, "home"));
  assert.equal(command.env.USERPROFILE, join(runDir, "home"));
  assert.equal(command.env.CLAUDE_CODE_SHELL_PREFIX, join(runDir, "bin", "async-subagents-bash"));
});

test("buildClaudeCommand normalizes Claude model aliases to canonical ids", () => {
  const runDir = mkdtempSync(join(tmpdir(), "async-subagents-claude-model-"));
  const command = buildClaudeCommand({
    runDir,
    cwd: runDir,
    systemPath: join(runDir, "artifacts", "system.md"),
    displayName: "worker/claude",
    model: "opus",
  });
  assert.equal(command.requestedModel, "opus");
  assert.equal(command.resolvedModel, "claude-opus-4-8");
  assert.deepEqual(resolveClaudeModel("sonnet"), { requestedModel: "sonnet", resolvedModel: "claude-sonnet-5" });
  assert.deepEqual(resolveClaudeModel("fable"), { requestedModel: "fable", resolvedModel: "claude-fable-5" });
  assert.equal(command.args[command.args.indexOf("--model") + 1], "claude-opus-4-8");
  assert.throws(() => resolveClaudeModel("claude-opus-4-5"), /unsupported Claude model/);
});

test("buildClaudeCommand preserves extra env but does not let it override Claude homes", () => {
  const runDir = mkdtempSync(join(tmpdir(), "async-subagents-claude-env-"));
  const command = buildClaudeCommand({
    runDir,
    cwd: runDir,
    systemPath: join(runDir, "artifacts", "system.md"),
    displayName: "worker/claude",
    homeDir: join(runDir, "custom-home"),
    shellWrapperPath: join(runDir, "bin", "shell"),
    extraEnv: { HOME: "/operator", USERPROFILE: "/operator-profile", KEEP: "yes" },
  });
  assert.equal(command.env.KEEP, "yes");
  assert.equal(command.env.HOME, join(runDir, "custom-home"));
  assert.equal(command.env.USERPROFILE, join(runDir, "custom-home"));
  assert.equal(command.env.CLAUDE_CODE_SHELL_PREFIX, join(runDir, "bin", "shell"));
});

test("prepareClaudeHome writes settings, strict MCP config, seeds credentials, shell split, and installs requested skills", () => {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-claude-home-"));
  const skill = join(root, "skills", "repo-nav");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "# Repo nav\n", "utf8");
  writeFileSync(join(skill, "notes.md"), "notes\n", "utf8");

  const prepared = prepareClaudeHome({
    runDir: join(root, "run"),
    mode: "interactive",
    mcpServerCommand: "node",
    mcpServerArgs: ["server.js"],
    operatorHome: operatorHome(root),
    skills: [{ name: "repo-nav", sourceDir: skill }],
  });
  const settings = JSON.parse(readFileSync(prepared.settingsPath, "utf8"));
  const mcp = JSON.parse(readFileSync(prepared.mcpConfigPath, "utf8"));
  assert.equal(settings.permissions.defaultMode, "bypassPermissions");
  assert.equal(settings.skipDangerousModePermissionPrompt, true);
  assert.equal(mcp.mcpServers.async_subagents.command, "node");
  assert.match(readFileSync(join(prepared.homeDir, ".claude", "skills", "repo-nav", "SKILL.md"), "utf8"), /Repo nav/);
  assert.equal(existsSync(join(prepared.homeDir, ".claude", ".credentials.json")), true);
  assert.equal(existsSync(join(prepared.homeDir, ".claude", "settings.json")), false);
  assert.equal(existsSync(join(prepared.homeDir, ".claude", "CLAUDE.md")), false);
  assert.equal(prepared.authHome, "seeded-run-home");
  assert.equal(prepared.memoryIsolation, "best-effort-non-bare");
  assert.equal(prepared.shellHomeDir, join(root, "run", "shell-home"));
  assert.match(readFileSync(prepared.shellWrapperPath, "utf8"), /export HOME=/);
  assert.equal(prepared.installedSkills[0].name, "repo-nav");
});

test("prepareClaudeHome rejects operator-home auth with requested skills", () => {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-claude-operator-home-skills-"));
  const home = operatorHome(root);
  const skill = join(root, "skill");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "# Skill\n", "utf8");
  assert.throws(
    () => prepareClaudeHome({ runDir: join(root, "run"), mode: "oneshot", operatorHome: home, authHome: "operator-home", skills: [{ name: "skill", sourceDir: skill }] }),
    /operator-home auth cannot guarantee run-local Claude skill visibility/,
  );
});

test("prepareClaudeHome supports operator-home auth metadata and command HOME", () => {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-claude-operator-home-"));
  const home = operatorHome(root);
  const prepared = prepareClaudeHome({ runDir: join(root, "run"), mode: "oneshot", operatorHome: home, authHome: "operator-home" });
  assert.equal(prepared.authHome, "operator-home");
  assert.equal(prepared.homeDir, home);
  assert.equal(existsSync(prepared.settingsPath), true);
  assert.equal(existsSync(prepared.mcpConfigPath), true);
  assert.equal(existsSync(prepared.shellHomeDir), true);

  const command = buildClaudeCommand({
    runDir: join(root, "run"),
    cwd: root,
    systemPath: join(root, "run", "artifacts", "system.md"),
    displayName: "worker/claude",
    homeDir: prepared.homeDir,
    shellWrapperPath: prepared.shellWrapperPath,
  });
  assert.equal(command.env.HOME, home);
  assert.equal(command.env.USERPROFILE, home);
});

test("prepareClaudeHome shell wrapper single-quotes shell home and executes command strings", () => {
  const root = join(mkdtempSync(join(tmpdir(), "async-subagents-claude-shell-")), "path with $dollar `ticks` and 'quote'");
  const home = operatorHome(root);
  const prepared = prepareClaudeHome({ runDir: join(root, "run"), mode: "oneshot", operatorHome: home });
  const wrapper = readFileSync(prepared.shellWrapperPath, "utf8");
  assert.match(wrapper, /export HOME='.*'"'"'.*'/);
  assert.doesNotMatch(wrapper, /export HOME=\"/);
  const output = execFileSync(prepared.shellWrapperPath, ["printf '%s:%s' \"$HOME\" \"$1\"", "sentinel"], { encoding: "utf8" });
  assert.equal(output, `${prepared.shellHomeDir}:sentinel`);
});

test("prepareClaudeHome rejects unsafe skill installation inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-claude-bad-skill-"));
  const skill = join(root, "skill");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "# Skill\n", "utf8");
  const home = operatorHome(root);
  assert.throws(() => prepareClaudeHome({ runDir: join(root, "run1"), mode: "oneshot", operatorHome: home, skills: [{ name: "../bad", sourceDir: skill }] }), /invalid Claude skill name/);
  assert.throws(() => prepareClaudeHome({ runDir: join(root, "run2"), mode: "oneshot", operatorHome: home, skills: [{ name: "dup", sourceDir: skill }, { name: "dup", sourceDir: skill }] }), /duplicate Claude skill name/);
  const noEntry = join(root, "no-entry");
  mkdirSync(noEntry, { recursive: true });
  assert.throws(() => prepareClaudeHome({ runDir: join(root, "run3"), mode: "oneshot", operatorHome: home, skills: [{ name: "empty", sourceDir: noEntry }] }), /SKILL.md/);
});

test("prepareClaudeHome fails closed for interactive Claude without MCP command", () => {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-claude-no-mcp-"));
  assert.throws(() => prepareClaudeHome({ runDir: join(root, "run"), mode: "interactive", operatorHome: operatorHome(root) }), /MCP server command/);
});

test("prepareClaudeHome permits oneshot empty strict MCP config", () => {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-claude-oneshot-mcp-"));
  const prepared = prepareClaudeHome({ runDir: join(root, "run"), mode: "oneshot", operatorHome: operatorHome(root) });
  assert.deepEqual(JSON.parse(readFileSync(prepared.mcpConfigPath, "utf8")), { mcpServers: {} });
});

test("prepareClaudeHome fails clearly when seeded credentials are missing", () => {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-claude-missing-creds-"));
  assert.throws(() => prepareClaudeHome({ runDir: join(root, "run"), mode: "oneshot", operatorHome: join(root, "missing") }), /OAuth credentials missing/);
});

test("prepareClaudeHome rejects symlinks, path escapes, and skill limits", () => {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-claude-skill-limits-"));
  const home = operatorHome(root);
  const skill = join(root, "skills", "limited");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "# Skill\n", "utf8");
  writeFileSync(join(skill, "big.txt"), "12345", "utf8");
  assert.throws(() => prepareClaudeHome({ runDir: join(root, "run1"), mode: "oneshot", operatorHome: home, skills: [{ name: "limited", sourceDir: skill, maxBytes: 4 }] }), /byte limit/);
  assert.throws(() => prepareClaudeHome({ runDir: join(root, "run2"), mode: "oneshot", operatorHome: home, skills: [{ name: "limited", sourceDir: skill, maxFiles: 1 }] }), /file count/);
  const otherRoot = join(root, "other");
  mkdirSync(otherRoot, { recursive: true });
  assert.throws(() => prepareClaudeHome({ runDir: join(root, "run3"), mode: "oneshot", operatorHome: home, skills: [{ name: "limited", sourceDir: skill, approvedRoots: [otherRoot] }] }), /outside approved roots/);
  symlinkSync(join(skill, "big.txt"), join(skill, "link.txt"));
  assert.throws(() => prepareClaudeHome({ runDir: join(root, "run4"), mode: "oneshot", operatorHome: home, skills: [{ name: "limited", sourceDir: skill }] }), /unsupported symlink/);
});

test("prepareClaudeHome validates skill approved roots and copied entries by real paths", () => {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-claude-realpath-"));
  const home = operatorHome(root);
  const outside = join(root, "outside");
  const skill = join(outside, "skills", "escaped");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "# Escaped\n", "utf8");
  const approved = join(root, "approved");
  mkdirSync(approved, { recursive: true });
  symlinkSync(outside, join(approved, "linked-outside"));

  assert.throws(
    () => prepareClaudeHome({ runDir: join(root, "run1"), mode: "oneshot", operatorHome: home, skills: [{ name: "escaped", sourceDir: join(approved, "linked-outside", "skills", "escaped"), approvedRoots: [approved] }] }),
    /outside approved roots/,
  );
});

test("prepareClaudeHome allows filesystem root as approved root", () => {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-claude-root-approved-"));
  const home = operatorHome(root);
  const skill = join(root, "skill");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "# Skill\n", "utf8");
  const prepared = prepareClaudeHome({ runDir: join(root, "run"), mode: "oneshot", operatorHome: home, skills: [{ name: "skill", sourceDir: skill, approvedRoots: [resolve("/")] }] });
  assert.equal(prepared.installedSkills[0].name, "skill");
});
