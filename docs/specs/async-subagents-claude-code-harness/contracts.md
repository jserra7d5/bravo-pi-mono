# Contracts: Harness, Definitions, Parent Prompt, and Tool Surfaces

This module defines the harness abstraction and all model-facing parent surfaces affected by Claude variants.

## Harness abstraction

Introduce an internal harness interface instead of branching Claude behavior directly inside `piHarness.ts` or `start.ts`.

```ts
type HarnessKind = "pi" | "claude";

interface ChildHarness {
  kind: HarnessKind;
  validateDefinition(input: HarnessValidationInput): HarnessValidationResult;
  prepareHome(input: HarnessPrepareInput): Promise<HarnessPrepareResult>;
  buildCommand(input: HarnessCommandInput): HarnessCommandResult;
  preflight?(input: HarnessPreflightInput): Promise<HarnessPreflightResult>;
  supervisorAdapter: "stdio" | "tmux";
  resultParser?: "pi-text" | "claude-stream-json" | "mcp-terminal";
}
```

Ownership split:

- `start.ts` owns run identity, definition resolution, harness selection, prompt assembly, run-store writes, task association, subscriptions, and launch sequencing.
- `piHarness.ts` owns Pi command construction and child-control extension wiring.
- `claudeHarness.ts` owns Claude command construction, isolated Claude home/config, dangerous execution settings, skill installation, generated MCP config, and preflight.
- `supervisor.ts` owns process lifecycle and delegates transport-specific operations to the harness adapter.

Claude command/home/auth behavior should reuse or extract Tango Claude harness lessons where practical. If duplicated, add parity tests against documented Tango behavior so the two Claude integrations do not drift.

## Agent definition schema

Add harness-aware fields to definitions and variants:

```ts
type AgentHarness = "pi" | "claude";
type ClaudeMode = "oneshot" | "interactive";

type ClaudeExecutionMode = "dangerous-auth"; // normal Claude auth + dangerous skip, best-effort memory minimization

interface MarkdownAgentDefinition {
  harness?: AgentHarness;            // default: pi
  effort?: string;                   // Claude only
  skills?: string[];                 // logical, harness-resolved names
  claude?: ClaudeDefinitionOptions;  // Claude-only fields
  variants?: Record<string, AgentDefinitionVariant>;
}

interface AgentDefinitionVariant {
  harness?: AgentHarness;
  model?: string;
  thinkingLevel?: ThinkingLevel;     // Pi only
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | string; // Claude only
  tools?: string[];                  // Pi builtin tools only; explicit use on Claude fails
  skills?: string[];
  extensions?: string[];             // Pi only; explicit use on Claude fails
  mode?: ClaudeMode;                 // Claude only; Pi mode remains existing behavior
  claude?: ClaudeDefinitionOptions;
  context?: "fresh" | "fork";
  session?: "record" | "none";
  maxRunSeconds?: number;
}

interface ClaudeDefinitionOptions {
  executionMode?: ClaudeExecutionMode;
  authHome?: "seeded-run-home" | "operator-home";
  mode?: ClaudeMode;
  // v1 intentionally has no extraMcpServers. Requests for extra MCP servers fail pre-spawn.
}
```

## Harness boundary inheritance

Harness switching has explicit provenance rules.

For a `harness: "claude"` variant:

- inherited from base definition:
  - prompt body only when marked or treated as harness-neutral role/task content;
  - explicit prompt includes only when marked harness-neutral or Claude-compatible;
  - description;
  - task text behavior;
  - context/session metadata when supported;
  - non-execution metadata.
- not inherited across harness boundary:
  - base Pi `tools`;
  - base Pi `extensions`;
  - base Pi `thinkingLevel`;
  - configured Pi `defaultExtensions`;
  - `ASYNC_SUBAGENTS_INHERITED_EXTENSIONS`;
  - Pi child-control extension paths;
  - Pi provider extension requirements;
  - Pi-specific runtime prompt includes or child-control instructions.
- explicit on a Claude variant and therefore pre-spawn failure:
  - `tools`;
  - `extensions`;
  - `thinkingLevel` unless a future explicit mapping is implemented.

Launch metadata records non-inherited fields:

```json
{
  "notInheritedAcrossHarness": [
    { "field": "tools", "source": "base", "reason": "pi-only" },
    { "field": "extensions", "source": "defaultConfig", "reason": "pi-only" }
  ]
}
```

This lets built-in `worker` definitions keep Pi tools while exposing a `worker/claude` variant.

## Definition validation

Resolution defaults:

- missing `harness` defaults to `pi`;
- `harness: "claude"` defaults to `mode: "interactive"` unless explicitly set to `oneshot`;
- built-in Claude variants should still declare `mode: interactive` for readability;
- Claude effort defaults come from config only when neither definition nor variant sets `effort`.

Validation is pre-spawn and fail-closed:

- unknown `harness` fails;
- Claude variant with explicit `tools` fails;
- Claude variant with explicit `extensions` fails;
- Claude variant with `thinkingLevel` fails;
- Claude variant with incompatible or missing skills fails;
- Claude variant or config requesting extra MCP servers fails in v1 with `EXTRA_MCP_UNSUPPORTED`;
- Claude variant with unsupported `executionMode` fails;
- `dangerous-auth` must not pass `--bare` and must use the normal working Claude auth path;
- Pi definitions keep current behavior.

No field should be silently ignored. If a field or include is intentionally not inherited, record it as `notInheritedAcrossHarness` or `excludedAcrossHarness` with source/provenance.

## Parent system prompt module

Update `packages/async-subagents/extensions/pi/promptModule.ts` so the parent model learns harness-aware orchestration:

- Variants may switch harnesses, not only model/thinking/tools.
- `harness: claude` variants are Claude Code children managed by async-subagents run files and wakeups.
- Pi tools/extensions do not apply to Claude variants.
- `skills` are logical harness-resolved names.
- Claude interactive variants may be long-running; parent workflow remains wakeup-first: start, continue other work or go idle, answer `question`/`blocked`, collect terminal result.
- Do not repeatedly call `subagent_status` to watch a Claude child.
- Parent messages to Claude children are durable inbox messages plus terminal nudges. A terminal nudge is not proof of delivery.
- For `requiresAck`, treat success as message `handled` unless the tool result explicitly says it only waited for `received`.
- `thinkingLevel` overrides are Pi-only; Claude uses definition/variant `effort`.
- The effective catalog/tool result is the source of truth for harness/capabilities; do not infer a Claude variant's tools from the base Pi agent.

## Claude child system prompt contract

`promptAssembly.ts` must dispatch runtime instructions by harness.

Claude child prompts must include, in rendered system/task artifacts:

- exact async-subagents MCP tool names and purposes:
  - `subagent_event` for progress/artifact/question-like events;
  - `subagent_read_inbox` to fetch parent messages after a nudge or before resuming from waiting states;
  - `subagent_ack_inbox` after each parent message is actually handled;
  - `subagent_block` when blocked on parent input;
  - `subagent_complete` exactly once when the assigned task is complete;
  - `subagent_liveness` when reporting rate limit, compression, waiting, or stall states.
- completion rule: do not consider the task finished until `subagent_complete` succeeds.
- acknowledgement rule: reading inbox is not enough; call `subagent_ack_inbox` after acting on the message.
- parent-message rule: terminal nudges are only notifications; read full message bodies from MCP inbox.
- no recursive delegation through Claude's native `Task` tool.
- no Pi tools, no Pi extensions, no Pi `subagent_event` child-control extension.
- no direct mutation of async-subagents run files, tasks, or parent-owned milestone state.
- no assumption that base Pi tool names describe available Claude tools.
- respect the selected execution mode and workspace scope; the default Claude mode is trusted/dangerous, not a permission sandbox.

Rendered prompt tests must assert these instructions are present for Claude and absent/appropriately different for Pi. They must also assert that Pi-specific child-control instructions and Pi tool descriptions are excluded from Claude prompts, including inherited includes.

## Async Subagent Catalog

Update `extensions/pi/agentCatalog.ts` so each entry and variant can expose:

- `harness`;
- model when safe to display;
- Claude `effort`;
- Claude `mode`;
- execution mode (`dangerous-auth`);
- capability summary derived from the selected harness, not from base Pi tools;
- skills as harness-resolved capability hints;
- Pi extensions only for Pi variants;
- non-inherited base Pi fields when relevant.

Example:

```text
- `worker`
  description: "Implement a bounded task in the current repository."
  harness: pi; access: mutation-capable; capabilities: read, bash, edit, write
  variants: claude (harness: claude; mode: interactive; model: claude-sonnet-5; effort: high; execution: dangerous-auth; capabilities: claude-code, mcp-child-control, skills)
```

Do not label Claude variants safe because settings mention permissions. V1 Claude variants are trusted dangerous-mode children; catalog should expose that plainly.

## Tool schemas and descriptions

Update `extensions/pi/schema.ts` and `extensions/pi/tools.ts`.

### `subagent_start`

- `variant`: variants may change harness, including Claude.
- `skills`: logical names resolved for the selected harness; path-like values remain rejected.
- `thinkingLevel`: Pi-only; using it with Claude fails unless future mapping is explicitly added.
- No direct `effort` parameter in v1. Claude effort is authored in the definition/variant. Add a direct override only if an operator need appears later.
- Result details include `harness`, `launchHarness`, `mode`, `executionMode`, `model`, `resolvedSkills`, `notInheritedAcrossHarness`, launch log path, and transport metadata when available.

### `subagent_message`

Add or document acknowledgement options:

```ts
requiresAck?: boolean;
ackLevel?: "received" | "handled"; // default handled for Claude when requiresAck=true
ackTimeoutSeconds?: number;          // Claude default 30, max 120; Pi may keep shorter default
```

Tool result reports message delivery state:

- `queued`;
- `injected`;
- `received`;
- `handled`;
- `failed`;
- deadline and failure reason when applicable.

A terminal nudge alone must never report success for `requiresAck`.

### `subagent_continue`

- `thinkingLevel` remains Pi child-control only.
- Claude continuation can append a message, resume the process, extend budget, then inject a nudge.
- Ack timers for continuation messages start only after successful resume and terminal injection.
- Additional runtime budget updates durable budget fields.

### `subagent_status`

Include harness recovery fields when available:

- `harness`, `launchHarness`, `mode`, `executionMode`, `model`, `effort`;
- liveness state and last output/MCP timestamps;
- transport ownership and health;
- pending inbox delivery states;
- cleanup warnings;
- resolved skills and skill warnings.

Status recovery must check tmux/helper liveness for Claude interactive runs, not only PID existence.

### `subagent_result`

Include canonical metadata for review/recovery:

- `harness`, `launchHarness`, `mode`, `executionMode`, `model`;
- launch log path;
- Claude home path;
- shell home path;
- transport metadata;
- resolved skills;
- MCP/control logs;
- cleanup warnings;
- redacted stderr/stdout tails when relevant.

## Parent orchestration workflow

1. Choose a Claude variant only when the task benefits from Claude Code behavior, Claude-specific skills, or interactive management.
2. Start with normal `subagent_start({ agent, variant: "claude", task, skills? })`.
3. Do not poll; continue other work or go idle until an async wakeup arrives.
4. For `question`/`blocked`/`ack_failed`/`comatose`, answer or intervene with `subagent_message`, `subagent_continue`, or `subagent_interrupt`.
5. For `paused`, continue with the smallest needed `additionalRunSeconds` or cancel.
6. For terminal wakeup, use inline body when sufficient or `subagent_result` for canonical metadata/artifacts/logs.
7. Attach run ids/evidence to milestone tasks with `task_update` exactly like Pi children.

Claude children are sibling child processes. They cannot wait on other children. The parent owns dependency sequencing.
