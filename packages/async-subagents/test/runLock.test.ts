import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { withRunMutationLock } from "../src/runLock.js";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "async-subagents-lock-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("error", onError);
      stream.off("end", onEnd);
    };
    const onData = (chunk: Buffer | string) => {
      data += chunk.toString();
      const newline = data.indexOf("\n");
      if (newline >= 0) {
        cleanup();
        resolve(data.slice(0, newline));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("stream ended before line"));
    };
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("end", onEnd);
  });
}

async function waitForZombieIdentity(pid: number): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commEnd = stat.lastIndexOf(")");
      const fields = commEnd >= 0 ? stat.slice(commEnd + 2).trim().split(/\s+/) : [];
      if (fields[0] === "Z" && fields[19]) return `linux-proc-start:${fields[19]}`;
    } catch {
      // keep polling until the helper parent exits or the child becomes visible
    }
    await sleep(10);
  }
  throw new Error(`process ${pid} did not become a zombie`);
}

const hasPython3 = process.platform === "linux" && spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

test("withRunMutationLock serializes concurrent mutations", async () => {
  const runDir = workspace();
  const order: number[] = [];
  let active = 0;
  await Promise.all(Array.from({ length: 8 }, (_, index) => withRunMutationLock(runDir, async () => {
    active += 1;
    assert.equal(active, 1);
    await sleep(5);
    order.push(index);
    active -= 1;
  })));
  assert.equal(order.length, 8);
});

test("withRunMutationLock does not stale-steal a live long-held lock", async () => {
  const runDir = workspace();
  let active = 0;
  let enteredSecond = false;
  const first = withRunMutationLock(runDir, async () => {
    active += 1;
    assert.equal(active, 1);
    await sleep(80);
    active -= 1;
  }, { staleMs: 20, timeoutMs: 200, retryMs: 5, heartbeatMs: 5 });
  await sleep(10);
  const second = withRunMutationLock(runDir, async () => {
    enteredSecond = true;
    active += 1;
    assert.equal(active, 1);
    active -= 1;
  }, { staleMs: 20, timeoutMs: 200, retryMs: 5, heartbeatMs: 5 });
  await Promise.all([first, second]);
  assert.equal(enteredSecond, true);
});


test("withRunMutationLock removes stale reused-pid owner records by process identity", async () => {
  const runDir = workspace();
  const lockDir = join(runDir, ".mutation.lock");
  mkdirSync(lockDir);
  const staleAt = new Date(Date.now() - 10_000).toISOString();
  writeFileSync(join(lockDir, "owner.stale-token.json"), JSON.stringify({ pid: process.pid, token: "stale-token", host: hostname(), processIdentity: "different-process-start", acquiredAt: staleAt, heartbeatAt: staleAt }), "utf8");
  const result = await withRunMutationLock(runDir, () => "ok", { timeoutMs: 200, staleMs: 10, retryMs: 5 });
  assert.equal(result.value, "ok");
});


test("withRunMutationLock does not heartbeat-steal a stalled live same-host owner", async () => {
  const runDir = workspace();
  const lockDir = join(runDir, ".mutation.lock");
  mkdirSync(lockDir);
  const staleAt = new Date(Date.now() - 10_000).toISOString();
  const ownerPath = join(lockDir, "owner.live-token.json");
  writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token: "live-token", host: hostname(), acquiredAt: staleAt, heartbeatAt: staleAt }), "utf8");
  const before = Date.now();
  await assert.rejects(() => withRunMutationLock(runDir, () => "stolen", { timeoutMs: 50, staleMs: 10, retryMs: 5 }), /timed out/);
  assert.ok(Date.now() - before >= 45);
  assert.ok(statSync(join(lockDir, "owner.live-token.json")).isFile());
});


test("withRunMutationLock treats Linux zombie owners as dead", { skip: hasPython3 ? false : "requires Linux with python3" }, async () => {
  const helper = spawn("python3", ["-c", `import os, sys, time\npid = os.fork()\nif pid == 0:\n    os._exit(0)\nprint(pid, flush=True)\ntime.sleep(30)\n`], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    assert.ok(helper.stdout);
    const zombiePid = Number.parseInt(await readLine(helper.stdout), 10);
    assert.ok(Number.isInteger(zombiePid) && zombiePid > 0);
    const identity = await waitForZombieIdentity(zombiePid);

    const runDir = workspace();
    const lockDir = join(runDir, ".mutation.lock");
    mkdirSync(lockDir);
    const staleAt = new Date(Date.now() - 10_000).toISOString();
    writeFileSync(join(lockDir, "owner.zombie-token.json"), JSON.stringify({ pid: zombiePid, token: "zombie-token", host: hostname(), processIdentity: identity, acquiredAt: staleAt, heartbeatAt: staleAt }), "utf8");

    const result = await withRunMutationLock(runDir, () => "ok", { timeoutMs: 200, staleMs: 10, retryMs: 5 });
    assert.equal(result.value, "ok");
  } finally {
    if (helper.exitCode === null) helper.kill("SIGKILL");
  }
});


test("withRunMutationLock release removes only its token owner file", async () => {
  const runDir = workspace();
  const foreignToken = "foreign-token";
  await withRunMutationLock(runDir, () => {
    const lockDir = join(runDir, ".mutation.lock");
    const now = new Date().toISOString();
    writeFileSync(join(lockDir, `owner.${foreignToken}.json`), JSON.stringify({ pid: process.pid, token: foreignToken, host: hostname(), acquiredAt: now, heartbeatAt: now }), "utf8");
  }, { timeoutMs: 200, staleMs: 10_000, retryMs: 5 });
  assert.ok(statSync(join(runDir, ".mutation.lock", `owner.${foreignToken}.json`)).isFile());
});


test("withRunMutationLock removes stale locks and times out on live locks", async () => {
  const staleRunDir = workspace();
  const staleLock = join(staleRunDir, ".mutation.lock");
  mkdirSync(staleLock);
  const past = new Date(Date.now() - 10_000);
  utimesSync(staleLock, past, past);
  const result = await withRunMutationLock(staleRunDir, () => "ok", { timeoutMs: 200, staleMs: 100 });
  assert.equal(result.value, "ok");

  const liveRunDir = workspace();
  const liveLock = join(liveRunDir, ".mutation.lock");
  mkdirSync(liveLock);
  const liveToken = "live-token";
  const now = new Date().toISOString();
  writeFileSync(join(liveLock, `owner.${liveToken}.json`), JSON.stringify({ pid: process.pid, token: liveToken, host: hostname(), acquiredAt: now, heartbeatAt: now }), "utf8");
  const before = Date.now();
  await assert.rejects(() => withRunMutationLock(liveRunDir, () => undefined, { timeoutMs: 50, staleMs: 10_000, retryMs: 5 }), /timed out/);
  assert.ok(Date.now() - before >= 45);
  assert.ok(statSync(join(liveRunDir, ".mutation.lock", `owner.${liveToken}.json`)).isFile());
});
