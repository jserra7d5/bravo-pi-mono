import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { BrowserWorkspaceConfigV1 as C, ExternalCommand } from "./contracts.js";
import { buildTtyd } from "./commands.js";
import { Exit, WorkspaceError } from "./errors.js";
import { abortableSleep, fetchBounded, processGroupMembers, readProcessIdentity, sameProcess, type ProcessIdentity } from "./process.js";

interface TtydOwnership { identity: ProcessIdentity; executable: string; argv: string[] }
function liveExecutable(pid: number): string { return fs.realpathSync(`/proc/${pid}/exe`); }
function liveArgv(pid: number): string[] { return fs.readFileSync(`/proc/${pid}/cmdline`).toString().split("\0").filter(Boolean); }
function validOwnershipRecord(value: TtydOwnership, executable: string): boolean {
  if (!Number.isInteger(value?.identity?.pid) || value.identity.pid < 2 || value.identity.pgid !== value.identity.pid || value.identity.uid !== process.getuid?.() || !Array.isArray(value.argv)) return false;
  try { return fs.realpathSync(value.executable) === fs.realpathSync(executable); } catch { return false; }
}
function ownershipMatches(value: TtydOwnership, executable: string): boolean {
  if (!validOwnershipRecord(value, executable)) return false;
  try { return sameProcess(value.identity) && liveExecutable(value.identity.pid) === fs.realpathSync(executable) && JSON.stringify(liveArgv(value.identity.pid)) === JSON.stringify(value.argv); } catch { return false; }
}
function exactOwnedGroup(value: TtydOwnership): ProcessIdentity[] | undefined {
  const members = processGroupMembers(value.identity.pgid);
  if (!members.length) return [];
  if (members.some(member => member.uid !== value.identity.uid || (member.pid === value.identity.pid && !sameProcess(value.identity)))) return;
  // tmux is intentionally outside ttyd ownership even if a malformed process tree puts it in this group.
  try { if (members.some(member => { try { return path.basename(liveExecutable(member.pid)) === "tmux"; } catch { return fs.readFileSync(`/proc/${member.pid}/comm`, "utf8").trim() === "tmux"; } })) return; } catch { return; }
  return members;
}
function signalExactOwnedGroup(value: TtydOwnership, signal: NodeJS.Signals): boolean {
  const members = exactOwnedGroup(value);
  if (!members?.length) return false;
  try { process.kill(-value.identity.pgid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  return true;
}
export function defaultTtydOwnershipFile(c: C, env = process.env): string {
  const root = env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `bravo-browser-workspace-${process.getuid?.() ?? "user"}`);
  return path.join(root, "bravo-browser-workspace", `ttyd-${c.tmuxSocketName}-${c.listenPort}.json`);
}
export async function recoverOwnedTtyd(file: string, executable: string): Promise<boolean> {
  let value: TtydOwnership | undefined;
  try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) return false; value = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  if (!value || !validOwnershipRecord(value, executable)) { try { fs.unlinkSync(file); } catch {} return false; }
  const leaderMatches = ownershipMatches(value, executable), members = exactOwnedGroup(value);
  if (!members) { try { fs.unlinkSync(file); } catch {} return false; }
  if (!leaderMatches && !members.length) { try { fs.unlinkSync(file); } catch {} return false; }
  if (!leaderMatches && members.some(member => member.pid === value!.identity.pid)) { try { fs.unlinkSync(file); } catch {} return false; }
  signalExactOwnedGroup(value, "SIGTERM");
  for (let i = 0; i < 100 && exactOwnedGroup(value)?.length; i++) await abortableSleep(50);
  if (exactOwnedGroup(value)?.length) signalExactOwnedGroup(value, "SIGKILL");
  for (let i = 0; i < 40 && exactOwnedGroup(value)?.length; i++) await abortableSleep(50);
  const remaining = exactOwnedGroup(value);
  if (!remaining) { try { fs.unlinkSync(file); } catch {} throw new WorkspaceError("TTYD_OWNER_GROUP_INVALID", "ttyd process group ownership changed during cleanup", Exit.RUNTIME); }
  if (remaining.length) { try { fs.unlinkSync(file); } catch {} throw new WorkspaceError("TTYD_GROUP_REMAINS", "Previously owned ttyd process group survived cleanup", Exit.RUNTIME); }
  try { fs.unlinkSync(file); } catch {} return true;
}
export async function assertPortFree(port: number): Promise<void> { await new Promise<void>((resolve, reject) => { const server = net.createServer(); server.once("error", () => reject(new WorkspaceError("PORT_OCCUPIED", `Port ${port} is occupied`, Exit.CONFLICT))); server.listen(port, "127.0.0.1", () => server.close(error => error ? reject(error) : resolve())); }); }
export class TtydSupervisor {
  private child?: ChildProcess; private identity?: ProcessIdentity; private command?: ExternalCommand; private ownerWritten = false; private stopping = false; private exit?: { code: number | null; signal: NodeJS.Signals | null }; private spawnError?: NodeJS.ErrnoException;
  constructor(readonly config: C, readonly env = process.env, readonly sessionFromUrl = false, readonly ownershipFile?: string) {}
  private writeOwnership(identity: ProcessIdentity, command: ExternalCommand) {
    if (!this.ownershipFile || this.ownerWritten) return;
    const dir = path.dirname(this.ownershipFile); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
    const temporary = `${this.ownershipFile}.${process.pid}.tmp`, value: TtydOwnership = { identity, executable: fs.realpathSync(command.executable), argv: [command.executable, ...command.args] };
    try {
      const descriptor = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, this.ownershipFile);
      const directory = fs.openSync(dir, "r"); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      this.ownerWritten = true;
    } finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  private clearOwnership() {
    if (!this.ownershipFile || !this.identity) return;
    try { const value = JSON.parse(fs.readFileSync(this.ownershipFile, "utf8")) as TtydOwnership; if (value.identity.pid === this.identity.pid && value.identity.startTicks === this.identity.startTicks) fs.unlinkSync(this.ownershipFile); } catch {}
    this.ownerWritten = false;
  }
  async start(portChecked = false): Promise<number> {
    if (this.ownershipFile) await recoverOwnedTtyd(this.ownershipFile, this.config.executables.ttyd);
    if (!portChecked) await assertPortFree(this.config.listenPort);
    const command = buildTtyd(this.config, this.sessionFromUrl); this.command = command; this.child = spawn(command.executable, command.args, { env: this.env, detached: true, stdio: "ignore", shell: false });
    this.child.once("error", error => { this.spawnError = error; }); this.child.once("exit", (code, signal) => { this.exit = { code, signal }; });
    const end = Date.now() + 10_000;
    while (Date.now() < end) {
      if (this.spawnError) throw new WorkspaceError("TTYD_SPAWN_FAILED", "Cannot start ttyd", Exit.DEPENDENCY, { code: this.spawnError.code });
      if (this.child.pid && !this.identity) {
        let identity: ProcessIdentity | undefined; try { identity = readProcessIdentity(this.child.pid); } catch {}
        if (identity) {
          if (identity.pgid !== identity.pid) { try { process.kill(identity.pid, "SIGKILL"); } catch {} throw new WorkspaceError("TTYD_GROUP_INVALID", "ttyd must lead its process group", Exit.RUNTIME); }
          try { this.writeOwnership(identity, command); }
          catch (error) {
            const members = processGroupMembers(identity.pgid); if (members.length && members.every(member => member.uid === identity!.uid)) try { process.kill(-identity.pgid, "SIGKILL"); } catch {}
            try { if (this.ownershipFile) fs.unlinkSync(this.ownershipFile); } catch {}
            throw new WorkspaceError("TTYD_OWNERSHIP_WRITE_FAILED", "Cannot durably record ttyd ownership", Exit.RUNTIME, { cause: error instanceof Error ? error.message : String(error) });
          }
          this.identity = identity;
        }
      }
      if (this.exit) throw new WorkspaceError("TTYD_EXITED", "ttyd exited before readiness", Exit.RUNTIME, this.exit);
      try { if (this.identity && (!this.ownershipFile || this.ownerWritten) && (await fetchBounded(`http://127.0.0.1:${this.config.listenPort}/`, 500)).ok) return this.identity.pid; } catch {}
      await abortableSleep(100);
    }
    await this.stop(); throw new WorkspaceError("TTYD_READINESS_TIMEOUT", "ttyd readiness timed out", Exit.RUNTIME);
  }
  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const owner = this.identity; if (!owner) return; this.stopping = true;
    const send = (next: NodeJS.Signals) => { if (!sameProcess(owner)) return; const members = processGroupMembers(owner.pgid); if (members.every(member => member.uid === owner.uid)) try { process.kill(-owner.pgid, next); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } };
    send(signal); for (let i = 0; i < 100 && sameProcess(owner); i++) await abortableSleep(50); if (sameProcess(owner)) send("SIGKILL");
    for (let i = 0; i < 40 && processGroupMembers(owner.pgid).length; i++) await abortableSleep(50);
    if (processGroupMembers(owner.pgid).length) throw new WorkspaceError("TTYD_GROUP_REMAINS", "ttyd process group survived cleanup", Exit.RUNTIME);
    this.clearOwnership();
  }
  async wait(): Promise<void> { if (!this.child || this.exit) return this.classify(); await new Promise<void>(resolve => this.child!.once("exit", () => resolve())); this.classify(); }
  private classify() { if (!this.stopping) throw new WorkspaceError("TTYD_EXITED", "ttyd exited unexpectedly", Exit.RUNTIME, this.exit); }
}
