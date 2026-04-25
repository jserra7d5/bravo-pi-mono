import type { AgentMetadata, CommandSpec } from "../types.js";

export function buildGenericCommand(meta: AgentMetadata, task: string): CommandSpec {
  return {
    command: "bash",
    args: ["-lc", task || "bash"],
    cwd: meta.cwd,
    env: {
      ...process.env as Record<string, string>,
      TANGO_AGENT_NAME: meta.name,
      TANGO_RUN_DIR: meta.runDir,
    },
  };
}
