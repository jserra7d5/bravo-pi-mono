#!/usr/bin/env node

import { supervisorMain } from "./supervisor.js";

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
  console.log(`async-subagents ${VERSION}

Usage:
  async-subagents --help
  async-subagents supervisor --input <path>

Pi extension tools provide runtime control; the supervisor subcommand is the child lifecycle entrypoint.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
