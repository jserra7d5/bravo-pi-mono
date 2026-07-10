import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserWorkspaceConfigV1, ConfigInitData } from "./contracts.js";
import { discoverRequiredExecutables } from "./discovery.js";
import { Exit, WorkspaceError } from "./errors.js";

const TOP = ["schemaVersion", "workspace", "listenHost", "listenPort", "tmuxSocketName", "tmuxSessionName", "tailscaleHttpsPort", "executables"];
const EXE = ["ttyd", "tmux", "tailscale", "pi"];
function object(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceError("CONFIG_INVALID", `${name} must be an object`, Exit.USAGE); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, keys: string[], name: string) { const unknown = Object.keys(value).filter(key => !keys.includes(key)); if (unknown.length) throw new WorkspaceError("CONFIG_UNKNOWN_KEY", `Unknown ${name} key: ${unknown[0]}`, Exit.USAGE); }
function executable(value: unknown, name: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new WorkspaceError("CONFIG_INVALID", `${name} must be absolute`, Exit.USAGE);
  try { const resolved = fs.realpathSync(value), stat = fs.statSync(resolved); fs.accessSync(resolved, fs.constants.X_OK); if (!stat.isFile()) throw new Error(); }
  catch { throw new WorkspaceError("DEPENDENCY_INVALID", `${name} must resolve to an executable file`, Exit.DEPENDENCY); }
  return value;
}
export function resolveConfigPath(explicit?: string, env = process.env): string { return path.resolve(explicit ?? env.BRAVO_BROWSER_WORKSPACE_CONFIG ?? path.join(os.homedir(), ".config/bravo-browser-workspace/config.json")); }
export function parseConfigV1(input: unknown): BrowserWorkspaceConfigV1 {
  const value = object(input, "config"); exactKeys(value, TOP, "config");
  const executables = object(value.executables, "executables"); exactKeys(executables, EXE, "executables");
  if (value.schemaVersion !== 1 || value.listenHost !== "127.0.0.1") throw new WorkspaceError("CONFIG_INVALID", "schemaVersion must be 1 and listenHost must be 127.0.0.1", Exit.USAGE);
  for (const key of ["listenPort", "tailscaleHttpsPort"] as const) if (!Number.isInteger(value[key]) || Number(value[key]) < 1 || Number(value[key]) > 65535) throw new WorkspaceError("CONFIG_INVALID", `${key} must be a valid port`, Exit.USAGE);
  const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
  if (typeof value.tmuxSocketName !== "string" || !identifier.test(value.tmuxSocketName) || typeof value.tmuxSessionName !== "string" || !identifier.test(value.tmuxSessionName)) throw new WorkspaceError("CONFIG_INVALID", "Invalid tmux identity", Exit.USAGE);
  if (typeof value.workspace !== "string" || !path.isAbsolute(value.workspace)) throw new WorkspaceError("CONFIG_INVALID", "workspace must be absolute", Exit.USAGE);
  try { const stat = fs.statSync(value.workspace); fs.accessSync(value.workspace, fs.constants.R_OK | fs.constants.W_OK); if (!stat.isDirectory()) throw new Error(); } catch { throw new WorkspaceError("CONFIG_INVALID", "workspace must be an existing readable/writable directory", Exit.USAGE); }
  return { schemaVersion: 1, workspace: value.workspace, listenHost: "127.0.0.1", listenPort: Number(value.listenPort), tmuxSocketName: value.tmuxSocketName, tmuxSessionName: value.tmuxSessionName, tailscaleHttpsPort: Number(value.tailscaleHttpsPort), executables: { ttyd: executable(executables.ttyd, "executables.ttyd"), tmux: executable(executables.tmux, "executables.tmux"), tailscale: executable(executables.tailscale, "executables.tailscale"), ...(executables.pi === undefined ? {} : { pi: executable(executables.pi, "executables.pi") }) } };
}
export function loadConfig(file: string) { try { return parseConfigV1(JSON.parse(fs.readFileSync(file, "utf8"))); } catch (error) { if (error instanceof WorkspaceError) throw error; throw new WorkspaceError("CONFIG_READ_FAILED", `Cannot read config: ${file}`, Exit.USAGE); } }
export function defaultConfig(ambientPath = process.env.PATH ?? ""): BrowserWorkspaceConfigV1 { return { schemaVersion: 1, workspace: os.homedir(), listenHost: "127.0.0.1", listenPort: 7681, tmuxSocketName: "bravo-browser-workspace", tmuxSessionName: "workspace", tailscaleHttpsPort: 8443, executables: discoverRequiredExecutables(ambientPath) }; }
export function initConfig(file: string, force = false): ConfigInitData { const bytes = `${JSON.stringify(defaultConfig(), null, 2)}\n`; fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); if (!force) fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 }); else { const temporary = `${file}.${process.pid}.tmp`; fs.writeFileSync(temporary, bytes, { mode: 0o600 }); fs.renameSync(temporary, file); fs.chmodSync(file, 0o600); } return { configPath: file, created: true, mode: "0600" }; }
