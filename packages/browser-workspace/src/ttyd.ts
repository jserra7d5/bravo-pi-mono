import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import type { BrowserWorkspaceConfigV1 as C } from "./contracts.js";
import { buildTtyd } from "./commands.js";
import { Exit, WorkspaceError } from "./errors.js";
import { abortableSleep, fetchBounded, processGroupMembers, readProcessIdentity, sameProcess, type ProcessIdentity } from "./process.js";
export async function assertPortFree(port: number): Promise<void> { await new Promise<void>((resolve, reject) => { const server = net.createServer(); server.once("error", () => reject(new WorkspaceError("PORT_OCCUPIED", `Port ${port} is occupied`, Exit.CONFLICT))); server.listen(port, "127.0.0.1", () => server.close(error => error ? reject(error) : resolve())); }); }
export class TtydSupervisor {
  private child?: ChildProcess; private identity?: ProcessIdentity; private stopping = false; private exit?: { code: number | null; signal: NodeJS.Signals | null }; private spawnError?: NodeJS.ErrnoException;
  constructor(readonly config: C, readonly env = process.env) {}
  async start(portChecked = false): Promise<number> {
    if (!portChecked) await assertPortFree(this.config.listenPort);
    const command = buildTtyd(this.config); this.child = spawn(command.executable, command.args, { env: this.env, detached: true, stdio: "ignore", shell: false });
    this.child.once("error", error => { this.spawnError = error; }); this.child.once("exit", (code, signal) => { this.exit = { code, signal }; });
    const end = Date.now() + 10_000;
    while (Date.now() < end) {
      if (this.spawnError) throw new WorkspaceError("TTYD_SPAWN_FAILED", "Cannot start ttyd", Exit.DEPENDENCY, { code: this.spawnError.code });
      if (this.child.pid && !this.identity) try { const identity = readProcessIdentity(this.child.pid); if (identity.pgid !== identity.pid) throw new WorkspaceError("TTYD_GROUP_INVALID", "ttyd must lead its process group", Exit.RUNTIME); this.identity = identity; } catch {}
      if (this.exit) throw new WorkspaceError("TTYD_EXITED", "ttyd exited before readiness", Exit.RUNTIME, this.exit);
      try { if ((await fetchBounded(`http://127.0.0.1:${this.config.listenPort}/`, 500)).ok) return this.identity!.pid; } catch {}
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
  }
  async wait(): Promise<void> { if (!this.child || this.exit) return this.classify(); await new Promise<void>(resolve => this.child!.once("exit", () => resolve())); this.classify(); }
  private classify() { if (!this.stopping) throw new WorkspaceError("TTYD_EXITED", "ttyd exited unexpectedly", Exit.RUNTIME, this.exit); }
}
