import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadIncludeFragments, type ResolvedAgentDefinition } from "./agentDefinitions.js";
import type { ContextPolicy, RunPaths, TaskRecord } from "./types.js";

export interface PromptAssemblyInput {
  definition: ResolvedAgentDefinition;
  runPaths: RunPaths;
  task: string;
  contextPolicy?: ContextPolicy;
  cwd: string;
  parentRunId: string;
  rootRunId: string;
  depth: number;
  files?: string[];
  skills?: string[];
  taskAssignment?: { task: TaskRecord; dependencies?: TaskRecord[] };
}

export interface PromptAssemblyResult {
  systemPath: string;
  taskPath: string;
  includePaths: string[];
  skills: string[];
  extensions: string[];
  model?: string;
  thinkingLevel?: ResolvedAgentDefinition["thinkingLevel"];
  mode: ResolvedAgentDefinition["mode"];
  maxRunSeconds?: number;
}

const runtimeContract = `You are a delegated child agent.
Work only on the assigned task and bounded scope.
Do not spawn child agents unless your effective recursion policy explicitly permits it.
Report completion through your normal final answer.
If you need parent input, call the subagent_event tool with type question or blocked.
Apply explicit fail-fast timeouts to tests, builds, git remotes, package installs, and network/API calls; disable interactive git/SSH prompts where practical, or skip the check with a clear reason if it cannot be safely bounded.
Respect all file and code safety instructions in the task.`;

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

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
  const taskOwnedContract = input.taskAssignment
    ? `\n\n# Task-Owned Result Contract\n\nYou are assigned to task ${input.taskAssignment.task.id}. Your durable handoff is the task result receipt, not a large final answer.\n\nWhen done:\n1. Call task_submit_result with a concise summary and receipt/artifact pointers.\n2. Keep your final answer brief: \"Submitted result for ${input.taskAssignment.task.id}.\"\n3. Do not duplicate the full receipt or artifact content in your final answer.\n\nUse task_update_progress for non-terminal progress and task_report_blocked if you need parent input.`
    : "";
  writeFileSync(systemPath, `${input.definition.body.trim()}${includeText}\n\n# Runtime Contract\n\n${runtimeContract}${taskOwnedContract}\n`, "utf8");
  const forkPreamble =
    input.contextPolicy === "fork"
      ? "You are running in a branched child Pi session. The inherited conversation is reference context only. Do not continue the parent thread or answer old user turns. Execute only the delegated task below and report the requested result.\n\n"
      : "";
  const assignment = input.taskAssignment
    ? `## Assigned Durable Task\n\nTask ID: ${input.taskAssignment.task.id}\nTitle: ${input.taskAssignment.task.title}\nAllowed task mutation: submit result/progress only for ${input.taskAssignment.task.id}.\nResult contract: attach a concise receipt/artifacts; do not mark parent acceptance.\nDependencies accepted:\n${(input.taskAssignment.dependencies ?? []).map((dep) => `- ${dep.id}: ${dep.title}`).join("\n") || "- (none)"}\n\n`
    : "";
  writeFileSync(
    taskPath,
    `# Assigned Task

${assignment}${forkPreamble}${input.task.trim()}

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
    skills: uniqueStrings([...input.definition.skills, ...(input.skills ?? [])]),
    extensions: input.definition.extensions,
    model: input.definition.model,
    thinkingLevel: input.definition.thinkingLevel,
    mode: input.definition.mode,
    maxRunSeconds: input.definition.maxRunSeconds,
  };
}
