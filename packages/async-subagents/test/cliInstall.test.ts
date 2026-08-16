import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * These drive the real CLI as a subprocess against throwaway HOME/claude dirs.
 *
 * `install` is the seam the whole distribution hangs off: it publishes the skill Claude
 * loads and the launcher path SKILL.md names literally. A stub of it would prove nothing,
 * because what can break is the filesystem behavior — a link pointing at a stale checkout,
 * a link that silently ate a real file — not the return value.
 */

// This file runs compiled, from dist/test/, so the package root is two levels up.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(PACKAGE_ROOT, "dist", "src", "cli.js");
const SKILL_SOURCE = join(PACKAGE_ROOT, "skills", "pi-async-subagents");

interface InstallResult {
  ok: boolean;
  skill: string;
  linked: { from: string; to: string };
  launcher: { from: string; to: string };
  replaced?: string;
  replacedLauncher?: string;
}

function workspace(): { home: string; claudeDir: string } {
  const root = mkdtempSync(join(tmpdir(), "async-subagents-install-"));
  return { home: join(root, "home"), claudeDir: join(root, "home", ".claude") };
}

function install(paths: { home: string; claudeDir: string }, ...extra: string[]): InstallResult {
  const stdout = execFileSync(process.execPath, [
    CLI, "install", "--claude-dir", paths.claudeDir, "--home", paths.home, ...extra,
  ], { encoding: "utf8" });
  return JSON.parse(stdout) as InstallResult;
}

function installError(paths: { home: string; claudeDir: string }, ...extra: string[]): string {
  try {
    install(paths, ...extra);
  } catch (error) {
    // The CLI reports failures as JSON on stdout with a non-zero exit.
    const stdout = String((error as { stdout?: unknown }).stdout ?? "");
    return stdout || String(error);
  }
  assert.fail("expected install to exit non-zero");
}

test("install links both the skill and the launcher into this checkout", () => {
  const paths = workspace();
  const result = install(paths);

  assert.equal(result.ok, true);
  assert.equal(result.skill, "pi-async-subagents");

  const skillLink = join(paths.claudeDir, "skills", "pi-async-subagents");
  assert.equal(result.linked.from, skillLink);
  assert.ok(lstatSync(skillLink).isSymbolicLink(), "the skill must be a symlink, not a copy");
  assert.equal(realpathSync(skillLink), realpathSync(SKILL_SOURCE));

  // The path SKILL.md names literally. If this string moves, every documented command breaks.
  const launcher = join(paths.home, ".async-subagents", "bin", "async-subagents");
  assert.equal(result.launcher.from, launcher);
  assert.ok(lstatSync(launcher).isSymbolicLink(), "the launcher must be a symlink so `pi update` follows");
  assert.equal(realpathSync(launcher), realpathSync(CLI));
});

test("the installed launcher actually executes the CLI", () => {
  const paths = workspace();
  install(paths);
  const launcher = join(paths.home, ".async-subagents", "bin", "async-subagents");

  // Invoked as a bare path, the way SKILL.md tells the agent to invoke it — this is what
  // catches a launcher that resolves but is not executable, or lost its shebang.
  const stdout = execFileSync(launcher, ["--help"], { encoding: "utf8" });
  assert.match(stdout, /Usage:/);
  assert.match(stdout, /async-subagents start --agent NAME/);
});

test("--version reports the manifest version, not a literal", () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string };
  const stdout = execFileSync(process.execPath, [CLI, "--version"], { encoding: "utf8" });

  // The repo carries one version and the Release workflow refuses a tag that disagrees
  // with it, so a CLI reporting its own literal would be the one place drift could hide.
  assert.equal(stdout.trim(), manifest.version);
  assert.notEqual(manifest.version, undefined);
});

test("install is idempotent and re-points a stale launcher", () => {
  const paths = workspace();
  install(paths);

  const launcher = join(paths.home, ".async-subagents", "bin", "async-subagents");
  const second = install(paths);

  assert.equal(second.replaced, "symlink");
  assert.equal(second.replacedLauncher, "symlink");
  assert.equal(readlinkSync(launcher), CLI);
});

test("install refuses to clobber a real skill directory or a real launcher file", () => {
  const paths = workspace();

  const skillDir = join(paths.claudeDir, "skills", "pi-async-subagents");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "hand-authored");
  assert.match(installError(paths), /exists and is not a symlink/);

  install(paths, "--force");
  assert.ok(lstatSync(skillDir).isSymbolicLink());

  const binDir = join(paths.home, ".async-subagents", "bin");
  const launcher = join(binDir, "async-subagents");
  rmSync(launcher);
  writeFileSync(launcher, "#!/bin/sh\necho someone else's wrapper\n");
  assert.match(installError(paths), /exists and is not a symlink/);

  const forced = install(paths, "--force");
  assert.equal(forced.replacedLauncher, "file");
  assert.ok(lstatSync(launcher).isSymbolicLink());
});
