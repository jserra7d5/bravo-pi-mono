import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RunStore } from "../src/runStore.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(PACKAGE_ROOT, "dist", "src", "cli.js");
const ROOT_ID = "root_cross_worktree";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" } });
}
function cli(cwd: string, env: NodeJS.ProcessEnv, args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8", timeout: 20_000 });
}

test("built CLI keeps start/run/watch storage canonical across two real git worktrees", { timeout: 60_000 }, () => {
  const temp = mkdtempSync(join(tmpdir(), "async-cli-worktrees-"));
  const canonical = join(temp, "canonical"), worktreeA = join(temp, "writer-a"), worktreeB = join(temp, "writer-b"), home = join(temp, "home");
  mkdirSync(canonical); mkdirSync(home);
  git(canonical, "init", "-q"); git(canonical, "config", "user.email", "test@example.invalid"); git(canonical, "config", "user.name", "Async Test");
  writeFileSync(join(canonical, "README.md"), "fixture\n");
  mkdirSync(join(canonical, ".agents"));
  writeFileSync(join(canonical, ".agents", "local.md"), `---\ndescription: Deterministic local subprocess fixture.\nmode: oneshot\nmaxRunSeconds: 10\n---\nRun the assigned fixture.\n`);
  git(canonical, "add", "README.md", ".agents/local.md"); git(canonical, "commit", "-qm", "fixture");
  git(canonical, "worktree", "add", "-qb", "writer-a", worktreeA); git(canonical, "worktree", "add", "-qb", "writer-b", worktreeB);

  const bin = join(temp, "bin"); mkdirSync(bin);
  const fakePi = join(bin, "pi");
  writeFileSync(fakePi, "#!/bin/sh\nprintf 'normal supervisor child completed\\n'\n"); chmodSync(fakePi, 0o755);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`, ASYNC_SUBAGENTS_HOME: join(home, ".async-subagents"), ASYNC_SUBAGENTS_NO_AUTO_ARCHIVE: "1" };

  const common = ["--root-session-id", ROOT_ID, "--store-cwd", canonical, "--agent", "local"];
  const first = JSON.parse(cli(worktreeA, env, ["start", ...common, "--cwd", worktreeA, "--task", "first fake child"]));
  const second = JSON.parse(cli(worktreeB, env, ["start", ...common, "--cwd", worktreeB, "--task", "second fake child"]));
  const synchronous = JSON.parse(cli(worktreeA, env, ["run", ...common, "--cwd", worktreeA, "--task", "synchronous fake child", "--timeout-seconds", "10"]));
  assert.equal(synchronous.start.started, true);
  assert.equal(synchronous.wait.results[0].state, "completed");

  const watched = cli(worktreeB, env, ["watch", "--store-cwd", canonical, "--run-id", first.runId, "--run-id", second.runId, "--run-id", synchronous.start.runId, "--interval-seconds", "0.01"])
    .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const watchedRuns = watched.filter((row) => typeof row.runId === "string");
  assert.deepEqual(new Set(watchedRuns.map((row) => row.runId)), new Set([first.runId, second.runId, synchronous.start.runId]));
  assert.ok(watchedRuns.every((row) => row.bucket === "terminal" && row.state === "completed"));

  const canonicalStore = new RunStore({ cwd: canonical, env });
  for (const [runId, executionCwd] of [[first.runId, worktreeA], [second.runId, worktreeB], [synchronous.start.runId, worktreeA]] as const) {
    const status = canonicalStore.readStatus(runId); assert.equal(status.cwd, executionCwd); assert.equal(status.rootSessionId, ROOT_ID);
    assert.equal(canonicalStore.readResult(runId)?.state, "completed");
    assert.match(canonicalStore.readResult(runId)?.body ?? "", /normal supervisor child completed/);
    const paths = canonicalStore.pathsFor({ runId });
    assert.equal(JSON.parse(readFileSync(join(paths.logsDir, "launch.json"), "utf8")).command, "pi");
    assert.equal(JSON.parse(readFileSync(join(paths.logsDir, "supervisor-input.json"), "utf8")).fake, undefined);
  }

  for (const executionCwd of [worktreeA, worktreeB]) {
    const executionStore = new RunStore({ cwd: executionCwd, env });
    assert.equal(existsSync(executionStore.runRoot), false, `unexpected execution-worktree run root: ${executionStore.runRoot}`);
  }
});
