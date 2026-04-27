import { homedir } from "node:os";
import { join } from "node:path";

export function resolveStateRoot(): string {
  if (process.env.PI_MONITOR_HOME) return process.env.PI_MONITOR_HOME;
  return join(homedir(), ".pi", "monitor");
}
