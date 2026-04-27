import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMetadata, CommandSpec } from "../types.js";

export function buildGenericCommand(meta: AgentMetadata, task: string): CommandSpec {
  return {
    command: "bash",
    args: ["-lc", task || "bash"],
    cwd: meta.cwd,
    env: {
      ...process.env as Record<string, string>,
      TANGO_HOME: process.env.TANGO_HOME ?? join(process.env.HOME ?? homedir(), ".tango"),
      TANGO_AGENT_NAME: meta.name,
      TANGO_RUN_DIR: meta.runDir,
      ...(meta.runId ? { TANGO_RUN_ID: meta.runId } : {}),
      ...(meta.parentRunDir ? { TANGO_PARENT_RUN_DIR: meta.parentRunDir } : {}),
      ...(meta.rootSessionId ? { TANGO_ROOT_SESSION_ID: meta.rootSessionId } : {}),
      ...(meta.workstreamId ? { TANGO_WORKSTREAM_ID: meta.workstreamId } : {}),
    },
    resultParser: "plain",
  };
}
