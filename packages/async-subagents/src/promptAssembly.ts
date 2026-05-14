import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadIncludeFragments, type ResolvedAgentDefinition } from "./agentDefinitions.js";
import type { RunPaths } from "./types.js";

export interface PromptAssemblyInput {
  definition: ResolvedAgentDefinition;
  runPaths: RunPaths;
  task: string;
  cwd: string;
  parentRunId: string;
  rootRunId: string;
  depth: number;
  files?: string[];
}

export interface PromptAssemblyResult {
  systemPath: string;
  taskPath: string;
  includePaths: string[];
  skills: string[];
  extensions: string[];
  model?: string;
  mode: ResolvedAgentDefinition["mode"];
  maxRunMs?: number;
}

const runtimeContract = `You are a delegated child agent.
Work only on the assigned task and bounded scope.
Do not spawn child agents unless your effective recursion policy explicitly permits it.
Report completion through your normal final answer.
If you need parent input, call the subagent_event tool with type question or blocked.
Respect all file and code safety instructions in the task.`;

export function assemblePrompt(input: PromptAssemblyInput): PromptAssemblyResult {
  const includeFragments = loadIncludeFragments(input.definition, { cwd: input.cwd });
  const includesDir = join(input.runPaths.artifactsDir, "includes");
  mkdirSync(includesDir, { recursive: true });
  const includePaths = includeFragments.map((fragment) => {
    const target = join(includesDir, basename(fragment.path));
    copyFileSync(fragment.path, target);
    return target;
  });

  const systemPath = join(input.runPaths.artifactsDir, "system.md");
  const taskPath = join(input.runPaths.artifactsDir, "task.md");
  const includeText = includeFragments.length
    ? `\n\n# Explicit Includes\n\n${includeFragments.map((fragment) => `## ${fragment.name}\n\n${fragment.body}`).join("\n\n")}`
    : "";
  writeFileSync(systemPath, `${input.definition.body.trim()}${includeText}\n\n# Runtime Contract\n\n${runtimeContract}\n`, "utf8");
  writeFileSync(
    taskPath,
    `# Assigned Task

${input.task.trim()}

# Run Metadata

- parentRunId: ${input.parentRunId}
- rootRunId: ${input.rootRunId}
- depth: ${input.depth}
- cwd: ${input.cwd}
- resultFormat: ${input.definition.resultFormat}

# Allowed Files

${(input.files ?? []).map((file) => `- ${file}`).join("\n") || "- (not specified)"}

# Inbox

Interactive agents should watch their inbox and acknowledge handled parent messages with the child event mechanism.
`,
    "utf8",
  );

  return {
    systemPath,
    taskPath,
    includePaths,
    skills: input.definition.skills,
    extensions: input.definition.extensions,
    model: input.definition.model,
    mode: input.definition.mode,
    maxRunMs: input.definition.maxRunMs,
  };
}
