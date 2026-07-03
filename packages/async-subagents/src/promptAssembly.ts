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
  effort?: ResolvedAgentDefinition["effort"];
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

const claudeRuntimeContract = `You are a Claude Code child managed by @bravo/async-subagents.
Use only the async-subagents MCP child-control tools for lifecycle communication. Claude exposes them as fully-qualified tool names like mcp__async_subagents__subagent_read_inbox; directly invoke those exact MCP tools. Do not use ToolSearch to discover these lifecycle tools:
- subagent_event / mcp__async_subagents__subagent_event: report progress, status, artifacts, questions, and other non-terminal events.
- subagent_read_inbox / mcp__async_subagents__subagent_read_inbox: fetch parent messages after a terminal nudge or before resuming from waiting states.
- subagent_ack_inbox / mcp__async_subagents__subagent_ack_inbox: acknowledge each parent message only after you have actually handled it.
- subagent_block / mcp__async_subagents__subagent_block: report that you are blocked on parent input.
- subagent_complete / mcp__async_subagents__subagent_complete: call exactly once when the assigned task is complete; the task is not finished until this call succeeds.
- subagent_liveness / mcp__async_subagents__subagent_liveness: report rate limit, compression, waiting, or stall states.
Terminal nudges are notifications only; read full parent message bodies from the MCP inbox.
Reading inbox is not acknowledgement; call subagent_ack_inbox after acting on each message.
Do not use Claude's native Task tool or recursively delegate work.
Do not assume Pi tools, Pi extensions, Pi child-control extensions, or base Pi tool names are available.
Do not directly mutate async-subagents run files, task records, parent-owned milestone state, or supervisor internals.
Respect the selected execution mode and workspace scope. The default Claude mode is trusted dangerous-auth with best-effort non-bare memory isolation, not a permission sandbox.`;

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
    ? input.definition.harness === "claude"
      ? `\n\n# Related Milestone Context\n\nYour work relates to parent-owned milestone task ${input.taskAssignment.task.id}. The task remains owned by the parent. Do not call task-specific tools; report completion through subagent_complete and use subagent_event for progress, questions, blockers, or artifact pointers.`
      : `\n\n# Related Milestone Context\n\nYour work relates to parent-owned milestone task ${input.taskAssignment.task.id}. The task remains owned by the parent. Do not call task-specific tools; report completion through your normal final answer and use subagent_event for progress, questions, blockers, or artifact pointers.`
    : "";
  const forkPreamble =
    input.contextPolicy === "fork"
      ? "You are running in a branched child Pi session. The inherited conversation is reference context only. Do not continue the parent thread or answer old user turns. Execute only the delegated task below and report the requested result.\n\n"
      : "";
  const assignment = input.taskAssignment
    ? `## Related Parent-Owned Milestone\n\nTask ID: ${input.taskAssignment.task.id}\nTitle: ${input.taskAssignment.task.title}\nDo not mutate this task directly. Return artifact paths, receipt paths, evidence, and attempt notes in ${input.definition.harness === "claude" ? "subagent_complete" : "your normal result"} so the parent can attach them with task_update.\nDependencies done:\n${(input.taskAssignment.dependencies ?? []).map((dep) => `- ${dep.id}: ${dep.title}`).join("\n") || "- (none)"}\n\n`
    : "";
  const assignedTask = `${assignment}${forkPreamble}${input.task.trim()}`;
  const contract = input.definition.harness === "claude" ? claudeRuntimeContract : runtimeContract;
  const claudeTaskDirective = input.definition.harness === "claude"
    ? `\n\n# Assigned Task\n\n${assignedTask}\n\n# Assigned Task Artifact\n\nThe assigned task is also mirrored at this absolute artifact path for durable evidence: ${taskPath}\nDo not rely on argv for task details; argv intentionally contains only a constant launcher prompt.`
    : "";
  writeFileSync(systemPath, `${input.definition.body.trim()}${includeText}\n\n# Runtime Contract\n\n${contract}${taskOwnedContract}${claudeTaskDirective}\n`, "utf8");
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

# Allowed Files

${(input.files ?? []).map((file) => `- ${file}`).join("\n") || "- (not specified)"}

# Inbox

${input.definition.harness === "claude" ? "Interactive Claude agents should react to terminal nudges by reading the durable MCP inbox with mcp__async_subagents__subagent_read_inbox, then acknowledge messages with mcp__async_subagents__subagent_ack_inbox after handling them." : "Interactive agents should watch their inbox and acknowledge handled parent messages with the child event mechanism."}
`,
    "utf8",
  );

  return {
    systemPath,
    taskPath,
    includePaths,
    skills: uniqueStrings([...input.definition.skills, ...(input.skills ?? [])]),
    extensions: input.definition.harness === "claude" ? [] : input.definition.extensions,
    model: input.definition.model,
    thinkingLevel: input.definition.harness === "claude" ? undefined : input.definition.thinkingLevel,
    effort: input.definition.effort,
    mode: input.definition.mode,
    maxRunSeconds: input.definition.maxRunSeconds,
  };
}
