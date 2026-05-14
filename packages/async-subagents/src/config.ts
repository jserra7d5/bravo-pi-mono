import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export function asyncSubagentsHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.ASYNC_SUBAGENTS_HOME ? resolve(env.ASYNC_SUBAGENTS_HOME) : join(env.HOME || homedir(), ".async-subagents");
}

export function findProjectRoot(cwd: string): string {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".git")) || existsSync(join(current, "package.json")) || existsSync(join(current, ".subagents"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

export function defaultRunRoot(cwd: string, configuredRoot?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (configuredRoot) return resolve(configuredRoot);
  if (env.ASYNC_SUBAGENTS_HOME) return join(resolve(env.ASYNC_SUBAGENTS_HOME), "runs");
  return join(findProjectRoot(cwd), ".subagents", "runs");
}

export function sessionRoot(cwd: string, configuredRoot?: string, env: NodeJS.ProcessEnv = process.env): string {
  const runRoot = defaultRunRoot(cwd, configuredRoot, env);
  return resolve(runRoot, "..", "sessions");
}

export function leaseRoot(cwd: string, configuredRoot?: string, env: NodeJS.ProcessEnv = process.env): string {
  const runRoot = defaultRunRoot(cwd, configuredRoot, env);
  return resolve(runRoot, "..", "leases");
}
