import { spawnSync } from "node:child_process";
import type { CommandSpec } from "../types.js";

export function hasTmux(): boolean {
  return spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
}

export function startTmux(socket: string, session: string, spec: CommandSpec): void {
  if (!hasTmux()) throw new Error("tmux is not available on PATH");
  const shellCommand = shellJoin([spec.command, ...spec.args]);
  const envArgs = Object.entries(spec.env).map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ");
  const envCommand = envArgs ? `env ${envArgs} ${shellCommand}` : shellCommand;
  const cmd = `cd ${shellQuote(spec.cwd)} && exec ${envCommand}`;
  const result = spawnSync("tmux", ["-S", socket, "new-session", "-d", "-s", session, "bash", "-lc", cmd], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || "failed to start tmux session");
}

export function captureTmux(socket: string, session: string, lines = 200): string {
  const result = spawnSync("tmux", ["-S", socket, "capture-pane", "-p", "-t", session, "-S", `-${lines}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || "failed to capture tmux pane");
  return result.stdout;
}

export function attachTmux(socket: string, session: string): void {
  const result = spawnSync("tmux", ["-S", socket, "attach-session", "-t", session], { stdio: "inherit" });
  process.exit(result.status ?? 0);
}

export function sendTmux(socket: string, session: string, message: string): void {
  const result = spawnSync("tmux", ["-S", socket, "send-keys", "-t", session, message, "Enter"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "failed to send message");
}

export function stopTmux(socket: string, session: string): void {
  spawnSync("tmux", ["-S", socket, "kill-session", "-t", session], { stdio: "ignore" });
}

export function tmuxAlive(socket: string, session: string): boolean {
  return spawnSync("tmux", ["-S", socket, "has-session", "-t", session], { stdio: "ignore" }).status === 0;
}

function shellJoin(parts: string[]): string { return parts.map(shellQuote).join(" "); }
function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
