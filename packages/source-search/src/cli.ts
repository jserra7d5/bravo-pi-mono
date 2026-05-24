#!/usr/bin/env node
import { spawn } from "node:child_process";
import { findSidecar } from "./sidecar.js";

async function main(): Promise<void> {
  const sidecar = await findSidecar();
  const child = spawn(sidecar, process.argv.slice(2), { stdio: "inherit", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

main().catch((error) => {
  const json = process.argv.includes("--json");
  const message = error instanceof Error ? error.message : String(error);
  if (json) console.log(JSON.stringify({ protocolVersion: 1, ok: false, error: message }));
  else console.error(message);
  process.exit(10);
});
