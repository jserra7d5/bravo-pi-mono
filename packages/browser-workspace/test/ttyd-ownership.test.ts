import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readProcessIdentity, sameProcess } from "../src/process.js";
import { recoverOwnedTtyd } from "../src/ttyd.js";

const waitForIdentity = async (pid: number) => { for (let i = 0; i < 50; i++) { try { return readProcessIdentity(pid); } catch { await new Promise(resolve => setTimeout(resolve, 10)); } } throw new Error("child identity unavailable"); };

test("stale ttyd ownership recovers only the exact recorded process", { timeout: 10_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-owner-")), file = path.join(dir, "ttyd.json");
  const script = "setInterval(() => {}, 1000)";
  const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
  assert.ok(child.pid); const identity = await waitForIdentity(child.pid);
  try {
    fs.writeFileSync(file, JSON.stringify({ identity, executable: fs.realpathSync(process.execPath), argv: [process.execPath, "-e", script] }), { mode: 0o600 });
    assert.equal(await recoverOwnedTtyd(file, process.execPath), true);
    assert.equal(sameProcess(identity), false);
    assert.equal(fs.existsSync(file), false);
  } finally { try { process.kill(-identity.pgid, "SIGKILL"); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
});

test("stale ttyd ownership cleans exact same-UID group members after its leader exits", { timeout: 10_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-owner-")), file = path.join(dir, "ttyd.json"), childFile = path.join(dir, "child.pid");
  const script = `const{spawn}=require('child_process'),fs=require('fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(childFile)},String(c.pid));setInterval(()=>{},1000)`;
  const leader = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
  assert.ok(leader.pid); const identity = await waitForIdentity(leader.pid);
  try {
    for (let i = 0; i < 100 && !fs.existsSync(childFile); i++) await new Promise(resolve => setTimeout(resolve, 10));
    const memberPid = Number(fs.readFileSync(childFile, "utf8")); const member = await waitForIdentity(memberPid);
    assert.equal(member.pgid, identity.pgid);
    fs.writeFileSync(file, JSON.stringify({ identity, executable: fs.realpathSync(process.execPath), argv: [process.execPath, "-e", script] }), { mode: 0o600 });
    process.kill(identity.pid, "SIGKILL");
    for (let i = 0; i < 100 && sameProcess(identity); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(sameProcess(identity), false);
    assert.equal(await recoverOwnedTtyd(file, process.execPath), true);
    assert.equal(sameProcess(member), false);
    assert.equal(fs.existsSync(file), false);
  } finally { try { process.kill(-identity.pgid, "SIGKILL"); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
});

test("mismatched ownership is discarded without signaling the process", { timeout: 5_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-owner-")), file = path.join(dir, "ttyd.json");
  const script = "setInterval(() => {}, 1000)";
  const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
  assert.ok(child.pid); const identity = await waitForIdentity(child.pid);
  try {
    fs.writeFileSync(file, JSON.stringify({ identity, executable: fs.realpathSync(process.execPath), argv: [process.execPath, "-e", "different"] }), { mode: 0o600 });
    assert.equal(await recoverOwnedTtyd(file, process.execPath), false);
    assert.equal(sameProcess(identity), true);
    assert.equal(fs.existsSync(file), false);
  } finally { try { process.kill(-identity.pgid, "SIGKILL"); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
});
