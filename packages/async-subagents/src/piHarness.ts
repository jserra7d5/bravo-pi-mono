import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson } from "./jsonl.js";
import type { ContextPolicy, SessionPolicy, ThinkingLevel } from "./types.js";

export interface BuildPiCommandInput {
  piBin?: string;
  systemPath: string;
  taskPath: string;
  runDir: string;
  cwd: string;
  sessionPolicy: SessionPolicy;
  piSessionPath?: string;
  requestedPiSessionPath?: string;
  userBuiltinTools: string[];
  runtimeBuiltinTools?: string[];
  runtimeExtensionPaths?: string[];
  skills: string[];
  defaultExtensionPaths?: string[];
  defaultExtensionTools?: string[];
  extensions: string[];
  model?: string;
  thinkingLevel?: ThinkingLevel;
  contextPolicy?: ContextPolicy;
  forkSourceSessionFile?: string;
  forkSourceLeafId?: string;
  forkFallback?: { allowed: boolean; used: boolean; reason?: string } | null;
  continuation?: {
    continuedFromRunId: string;
    continuationRootRunId?: string;
    continuationSequence?: number;
    continuationOfPiSessionPath?: string;
  };
  rootSessionId?: string;
  parentRunId?: string;
  useAtFilePrompt?: boolean;
  extraEnv?: Record<string, string>;
}

export interface PiCommand {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

const here = dirname(fileURLToPath(import.meta.url));
export const childControlEventTool = "subagent_event";

function findPackageRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "package.json")) && basename(current) === "async-subagents") return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start, "..");
    current = parent;
  }
}

export const childControlExtensionPath = join(findPackageRoot(here), "extensions", "child-control");

function dedupeExtensionsByRealpath(extensions: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const extension of extensions) {
    const key = existsSync(extension) ? `real:${realpathSync(extension)}` : `literal:${extension}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(extension);
  }
  return result;
}

export function buildPiCommand(input: BuildPiCommandInput): PiCommand {
  const runtimeBuiltinTools = input.runtimeBuiltinTools ?? [childControlEventTool];
  const runtimeExtensionPaths = input.runtimeExtensionPaths ?? [childControlExtensionPath];
  const toolAllowlist = [...new Set([...input.userBuiltinTools, ...(input.defaultExtensionTools ?? []), ...runtimeBuiltinTools])];
  const extensionPaths = dedupeExtensionsByRealpath([...(input.defaultExtensionPaths ?? []), ...input.extensions, ...runtimeExtensionPaths]);
  const args = [
    ...(input.sessionPolicy === "record" ? ["--session", input.piSessionPath ?? input.requestedPiSessionPath ?? join(input.runDir, "pi-session", "session.jsonl")] : ["--no-session"]),
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-extensions",
    "--append-system-prompt",
    "",
    "--system-prompt",
    input.systemPath,
  ];
  args.push("--tools", toolAllowlist.join(","));
  for (const skill of input.skills) args.push("--skill", skill);
  for (const extension of extensionPaths) args.push("-e", extension);
  if (input.model) args.push("--model", input.model);
  if (input.thinkingLevel) args.push("--thinking", input.thinkingLevel);
  args.push("--mode", "text", "-p", input.useAtFilePrompt === false ? input.taskPath : `@${input.taskPath}`);

  return {
    command: input.piBin ?? "pi",
    args,
    cwd: input.cwd,
    env: input.extraEnv ?? {},
  };
}

export function writeLaunchLog(runDir: string, command: PiCommand): void {
  writeLaunchLogWithMetadata(runDir, command, {});
}

export function writeLaunchLogWithMetadata(runDir: string, command: PiCommand, metadata: Record<string, unknown>): string {
  const path = resolve(runDir, "logs", "launch.json");
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteJson(path, {
    schemaVersion: 1,
    command: command.command,
    args: command.args,
    cwd: command.cwd,
    env: Object.fromEntries(Object.entries(command.env).map(([key, value]) => [key, /TOKEN|SECRET|PASSWORD|COOKIE|AUTH|KEY/i.test(key) ? "<redacted>" : value])),
    ...metadata,
  });
  return path;
}
