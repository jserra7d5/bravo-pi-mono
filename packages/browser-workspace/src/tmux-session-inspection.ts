import path from "node:path";
import type { ExternalCommand } from "./contracts.js";
import { execBounded, type ExecResult } from "./process.js";

export type TmuxSessionInspection =
  | { state: "live"; sessionId: string; socketPath: string }
  | { state: "absent" }
  | { state: "unavailable" };

export type TmuxCommandRunner = (command: ExternalCommand, timeoutMs?: number, maxBytes?: number, signal?: AbortSignal) => Promise<ExecResult>;

export function parseTmuxSessionListing(result: ExecResult, targetName: string): TmuxSessionInspection {
  if (result.code !== 0 || result.signal !== null || result.stderr !== "") return { state: "unavailable" };
  if (!result.stdout) return { state: "absent" };
  const rows = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1).split("\n") : result.stdout.split("\n");
  const seenNames = new Set<string>(), seenIds = new Set<string>();
  let listedSocketPath: string | undefined;
  const parsed: Array<{ name: string; sessionId: string; socketPath: string }> = [];
  for (const row of rows) {
    const fields = row.split("\t");
    if (fields.length !== 3) return { state: "unavailable" };
    const [name, sessionId, socketPath] = fields;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(name) || !/^\$\d+$/u.test(sessionId) || !path.isAbsolute(socketPath) || seenNames.has(name) || seenIds.has(sessionId) || (listedSocketPath !== undefined && listedSocketPath !== socketPath)) return { state: "unavailable" };
    seenNames.add(name); seenIds.add(sessionId); listedSocketPath = socketPath; parsed.push({ name, sessionId, socketPath });
  }
  const exact = parsed.find(row => row.name === targetName);
  return exact ? { state: "live", sessionId: exact.sessionId, socketPath: exact.socketPath } : { state: "absent" };
}

export async function inspectTmuxSession(input: { executable: string; socketName: string; targetName: string; env?: NodeJS.ProcessEnv; run?: TmuxCommandRunner; timeoutMs?: number }): Promise<TmuxSessionInspection> {
  try {
    const result = await (input.run ?? execBounded)({ executable: input.executable, args: ["-L", input.socketName, "list-sessions", "-F", "#{session_name}\t#{session_id}\t#{socket_path}"], env: input.env }, input.timeoutMs ?? 1000);
    return parseTmuxSessionListing(result, input.targetName);
  } catch {
    return { state: "unavailable" };
  }
}
