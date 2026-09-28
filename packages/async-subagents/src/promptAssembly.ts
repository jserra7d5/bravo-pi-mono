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
  protect?: string[];
  skills?: string[];
  taskAssignment?: { task: TaskRecord; dependencies?: TaskRecord[] };
}

export interface PromptAssemblyResult {
  systemPath: string;
  taskPath: string;
  /** Prompt used when the supervisor relaunches this run into its recorded session. */
  resumePath: string;
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
    ? `\n\n# Related Milestone Context\n\nYour work relates to parent-owned milestone task ${input.taskAssignment.task.id}. The task remains owned by the parent. Do not call task-specific tools; report completion through your normal final answer and use subagent_event for progress, questions, blockers, or artifact pointers.`
    : "";
  const forkPreamble =
    input.contextPolicy === "fork"
      ? "You are running in a branched child Pi session. The inherited conversation is reference context only. Do not continue the parent thread or answer old user turns. Execute only the delegated task below and report the requested result.\n\n"
      : "";
  const assignment = input.taskAssignment
    ? `## Related Parent-Owned Milestone\n\nTask ID: ${input.taskAssignment.task.id}\nTitle: ${input.taskAssignment.task.title}\nDo not mutate this task directly. Return artifact paths, receipt paths, evidence, and attempt notes in your normal result so the parent can attach them with task_update.\nDependencies done:\n${(input.taskAssignment.dependencies ?? []).map((dep) => `- ${dep.id}: ${dep.title}`).join("\n") || "- (none)"}\n\n`
    : "";
  const assignedTask = `${assignment}${forkPreamble}${input.task.trim()}`;
  writeFileSync(systemPath, `${input.definition.body.trim()}${includeText}\n\n# Runtime Contract\n\n${runtimeContract}${taskOwnedContract}\n`, "utf8");
  writeFileSync(
    taskPath,
    `# Assigned Task

${assignedTask}

# Run Metadata

- parentRunId: ${input.parentRunId}
- rootRunId: ${input.rootRunId}
- depth: ${input.depth}
- cwd: ${input.cwd}
- resultFormat: ${input.definition.resultFormat}

# Write Scope

You may create or edit ONLY paths matching these entries. An entry is an exact file path, a directory root (write anything beneath it), or a glob (\`*\` within a path segment, \`**\` across segments). This is contract enforcement, not OS sandboxing.

${(input.files ?? []).map((file) => `- ${file}`).join("\n") || "- (not specified)"}

# Protected Paths

Never create, edit, or delete these paths, even where they match the write scope. Reading them is always allowed.

${(input.protect ?? []).map((file) => `- ${file}`).join("\n") || "- (none)"}

If completing the task requires writing a path outside the write scope, do not silently comply and do not end the run: report it with your blocked event mechanism (subagent_event type "blocked"), naming the exact paths and why they are needed, then continue any remaining in-scope work while awaiting the parent's scope amendment — it arrives as a parent message.

# Inbox

Interactive agents should watch their inbox and acknowledge handled parent messages with the child event mechanism.
`,
    "utf8",
  );

  // Relaunch prompt for a child killed mid-reply by a transient upstream refusal.
  // The supervisor points Pi at the same recorded session, so the child reads this
  // with its full history already in context — repeating the brief would only
  // invite it to start over. What it cannot infer is that its last turn died
  // between deciding to write and finishing the write, so say that plainly and
  // make reconciling the working tree the first step.
  const resumePath = join(input.runPaths.artifactsDir, "resume.md");
  writeFileSync(
    resumePath,
    `# Resume After an Interrupted Turn

Your previous turn was terminated by an upstream content filter before it could
finish. This was not a judgement about your task, and nothing you did caused it.
Your assigned task is unchanged and is mirrored at ${taskPath}.

The turn was cut off mid-reply, so a file edit or command may have been half
applied. Before continuing:

1. Inspect the working tree for partial or inconsistent edits from that turn.
2. Repair or revert anything left half-written.
3. Then resume the task from where it actually stands.

Do not restart work you have already completed.
`,
    "utf8",
  );

  return {
    systemPath,
    taskPath,
    resumePath,
    includePaths,
    skills: uniqueStrings([...input.definition.skills, ...(input.skills ?? [])]),
    extensions: input.definition.extensions,
    model: input.definition.model,
    thinkingLevel: input.definition.thinkingLevel,
    mode: input.definition.mode,
    maxRunSeconds: input.definition.maxRunSeconds,
  };
}
