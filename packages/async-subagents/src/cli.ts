#!/usr/bin/env node

import { claudeChildMcpMain } from "./claudeChildMcp.js";
import { supervisorMain } from "./supervisor.js";
import { watchSubagents } from "./watch.js";
import { archiveRuns } from "./archive.js";
import { RunStore } from "./runStore.js";

const VERSION = "0.1.0";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--version")) {
    console.log(VERSION);
    return;
  }
  if (argv[0] === "supervisor") {
    await supervisorMain(argv.slice(1));
    return;
  }
  if (argv[0] === "claude-child-mcp") {
    await claudeChildMcpMain(argv.slice(1));
    return;
  }
  if (argv[0] === "archive") {
    const args = argv.slice(1);
    const value = (flag: string) => {
      const index = args.lastIndexOf(flag);
      return index >= 0 ? args[index + 1] : undefined;
    };
    const olderThanText = value("--older-than-days");
    const capText = value("--cap");
    const olderThanDays = olderThanText === undefined ? 7 : Number(olderThanText);
    const cap = capText === undefined ? undefined : Number(capText);
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) throw new Error("--older-than-days must be a non-negative number");
    if (cap !== undefined && (!Number.isInteger(cap) || cap < 0)) throw new Error("--cap must be a non-negative integer");
    const result = await archiveRuns(new RunStore(), { olderThanDays, cap, dryRun: args.includes("--dry-run") });
    console.log(JSON.stringify(result));
    return;
  }
  if (argv[0] === "watch") {
    const args = argv.slice(1);
    const values = (flag: string) => args.flatMap((arg, index) => arg === flag && args[index + 1] ? [args[index + 1]!] : []);
    const value = (flag: string) => values(flag).at(-1);
    const runIds = values("--run-id");
    const cwd = value("--cwd");
    if (!cwd || !runIds.length) throw new Error("usage: async-subagents watch --cwd DIR --run-id RUN_ID [--run-id RUN_ID ...] [--interval-seconds N] [--no-result-body]");
    const intervalText = value("--interval-seconds");
    const intervalSeconds = intervalText === undefined ? 5 : Number(intervalText);
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) throw new Error("--interval-seconds must be a positive number");
    await watchSubagents({ cwd, runIds, intervalSeconds, includeResultBody: !args.includes("--no-result-body") });
    return;
  }
  console.log(`async-subagents ${VERSION}

Usage:
  async-subagents --help
  async-subagents supervisor --input <path>
  async-subagents claude-child-mcp --run-dir <runDir>
  async-subagents archive [--older-than-days <n>] [--dry-run] [--cap <n>]
  async-subagents watch --cwd <dir> --run-id <id> [--run-id <id> ...] [--interval-seconds <n>] [--no-result-body]

Pi extension tools provide runtime control; the supervisor subcommand is the child lifecycle entrypoint.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
