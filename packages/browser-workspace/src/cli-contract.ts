import { Exit, WorkspaceError } from "./errors.js";
export type CommandName = "config init" | "start" | "status" | "ingress inspect";
export interface ParsedCli { command: CommandName; config?: string; json: boolean; force: boolean; requireExisting: boolean }
function usage(message: string): never { throw new WorkspaceError("USAGE", message, Exit.USAGE); }
export function parseCli(argv: readonly string[]): ParsedCli {
  const two = argv.slice(0, 2).join(" "); const command: CommandName = two === "config init" || two === "ingress inspect" ? two : argv[0] === "start" || argv[0] === "status" ? argv[0] : usage("Expected config init, start, status, or ingress inspect");
  const parsed: ParsedCli = { command, json: false, force: false, requireExisting: false }; const start = command.includes(" ") ? 2 : 1;
  for (let i = start; i < argv.length; i++) { const flag = argv[i]; if (flag === "--config") { const value = argv[++i]; if (!value) usage("--config requires a path"); parsed.config = value; } else if (flag === "--json" && command !== "config init") parsed.json = true; else if (flag === "--force" && command === "config init") parsed.force = true; else if (flag === "--require-existing-tmux" && command === "start") parsed.requireExisting = true; else usage(`Invalid flag for ${command}: ${flag}`); }
  return parsed;
}
