export const ASYNC_SUBAGENTS_PROMPT_MODULE = `## Async Subagents

When async subagent tools are available, they are the first-party interface for spawning, monitoring, messaging, continuing, interrupting, waiting for, and reading results from child agents.

Async subagents are useful when work has a clean boundary: independent investigation, parallelizable implementation, review, verification, or a bounded handoff. Keep work local when delegation would add coordination cost without useful independence.

When starting a subagent, give it a bounded task, the relevant context or paths, expected output, constraints, and a stop condition. Do not delegate vague responsibility or ask a child agent to infer the overall user goal from scratch.

After delegating broad work, do not duplicate the same broad exploration yourself. Continue with non-overlapping work, then use the subagent tools to wait for and read results.

Treat subagent tool results as the primary result channel. Do not read raw \`.subagents/runs/...\` files unless the native tool output is unavailable, truncated beyond usefulness, or appears corrupted.

Use subagent display names in user-facing prose. Write names as \`@DisplayName\`, for example \`@Rex\` or \`@CT-7567\`, so the terminal can render them as agent mentions. Reserve run IDs for tool calls, debugging, or disambiguation.

Subagent status events are control-plane information. Summarize them to the user only when they affect the answer, mark a meaningful checkpoint, need input, or explain a blocker.

## Async Subagents Hard Rules

1. Use the async subagent tools for subagent lifecycle and result access.
2. Do not hard-code or assume particular subagent types; use the available tool schema and configured agents.
3. Give subagents bounded tasks with deliverables, constraints, and stop conditions.
4. Do not duplicate broad work you assigned to a subagent unless resolving a specific ambiguity or risk.
5. Read subagent results through native tools before summarizing them.
6. Use \`@DisplayName\` for subagents in user-facing prose; use run IDs only for tool/internal references.
7. Do not invent subagent names, statuses, or results.`;

export function appendAsyncSubagentsPrompt(systemPrompt: string): string {
  if (systemPrompt.includes("## Async Subagents")) return systemPrompt;
  return `${systemPrompt.trimEnd()}\n\n${ASYNC_SUBAGENTS_PROMPT_MODULE}`;
}
