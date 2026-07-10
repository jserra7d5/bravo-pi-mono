#!/usr/bin/env node
import { parseCli } from "./cli-contract.js";
import { initConfig, loadConfig, resolveConfigPath } from "./config.js";
import { asWorkspaceError } from "./errors.js";
import { inspectIngress } from "./ingress.js";
import { runServe } from "./serve.js";
import { getStatus } from "./status.js";
function output(json: boolean, data: unknown) { process.stdout.write(`${json ? JSON.stringify(data) : JSON.stringify(data, null, 2)}\n`); }
try {
  const parsed = parseCli(process.argv.slice(2)), configPath = resolveConfigPath(parsed.config);
  switch (parsed.command) {
    case "config init": output(false, initConfig(configPath, parsed.force)); break;
    case "status": output(parsed.json, await getStatus(loadConfig(configPath), configPath)); break;
    case "ingress inspect": output(parsed.json, await inspectIngress(loadConfig(configPath))); break;
    case "start": await runServe(loadConfig(configPath), configPath, parsed.requireExisting, status => output(parsed.json, status)); break;
  }
} catch (value) { const error = asWorkspaceError(value); process.stderr.write(`${error.code}: ${error.message}\n`); process.exitCode = error.exitClass; }
