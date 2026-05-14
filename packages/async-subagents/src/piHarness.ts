import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { atomicWriteJson } from "./jsonl.js";

export interface BuildPiCommandInput {
  piBin?: string;
  systemPath: string;
  taskPath: string;
  runDir: string;
  cwd: string;
  tools: string[];
  skills: string[];
  extensions: string[];
  model?: string;
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

export function buildPiCommand(input: BuildPiCommandInput): PiCommand {
  const toolAllowlist = [...new Set([...input.tools, childControlEventTool])];
  const args = [
    "--no-session",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-extensions",
    "--system-prompt",
    input.systemPath,
  ];
  args.push("--tools", toolAllowlist.join(","));
  for (const skill of input.skills) args.push("--skill", skill);
  for (const extension of [...input.extensions, childControlExtensionPath]) args.push("-e", extension);
  if (input.model) args.push("--model", input.model);
  args.push("--mode", "text", "-p", input.useAtFilePrompt === false ? input.taskPath : `@${input.taskPath}`);

  return {
    command: input.piBin ?? "pi",
    args,
    cwd: input.cwd,
    env: input.extraEnv ?? {},
  };
}

export function writeLaunchLog(runDir: string, command: PiCommand): void {
  const path = resolve(runDir, "logs", "launch.json");
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteJson(path, {
    schemaVersion: 1,
    command: command.command,
    args: command.args,
    cwd: command.cwd,
    env: Object.fromEntries(Object.entries(command.env).map(([key, value]) => [key, key.includes("TOKEN") || key.includes("SECRET") ? "<redacted>" : value])),
  });
}
