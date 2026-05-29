# Async Subagents v1 Implementation Plan

Date: 2026-05-14
Status: Superseded historical implementation plan

> Superseded: this plan describes the original wait-capable v1 implementation. The current async-subagents contract is wakeup-first: `subagent_wait`, sync start/continue modes, and public `maxRunMs` budgets were removed by `docs/specs/async-subagents-async-wakeups-timeouts/design.md`. Use that spec and `packages/async-subagents/README.md` for current tool and timeout semantics.

## Objective

Build a Pi-agent-only async subagent primitive that lets a parent Pi agent start one or more child Pi agents, continue working while they run, receive structured wake-ups, message running children, and collect durable results.

The implementation should preserve the useful terminal experience from the current Tango/Pi tooling without carrying over Tango's larger orchestration model. The core product is not a workflow engine. It is a small file-backed run primitive plus Pi tools and Pi renderers.

The defining v1 behavior:

- `subagent_start` creates a durable child run and returns immediately by default.
- `subagent_wait` race-waits on interesting child events or terminal results.
- `subagent_message` appends parent-to-child input.
- `subagent_result` reads a terminal result and marks the corresponding wake-up handled.
- `subagent_status` is a required read-only recovery/status tool, not a later manager feature.
- Terminal or attention-worthy child events surface automatically through Pi follow-up messages when supported.
- The live terminal UI shows active, blocked, and result-ready child runs with compact but useful status.
- Each child has an individualized markdown agent definition and prompt. It does not inherit the parent/global Pi system prompt, global prompt templates, ambient context files, ambient skills, ambient extensions, or ambient includes unless the agent definition explicitly opts in.
- v1 targets Pi only. Do not design or implement Claude Code, Gemini, Codex, generic shell, or model fallback harnesses.

## Cross-review readiness amendments

Independent review against the local Pi SDK/runtime found several issues that must be treated as implementation gates, not optional polish.

1. **Prompt isolation must use replacement, not append.**
   - The Pi launch command must use `--system-prompt <systemPath>`.
   - Do not use `--append-system-prompt` for child agent identity. That appends to Pi's base coding-agent prompt and violates the user's requirement that children use individualized prompts instead of the global/default system prompt.
   - Phase 0 must verify the local Pi CLI accepts file contents for `--system-prompt`; if not, implementation must pass the system prompt text directly and keep a redacted launch log.

2. **Live messaging requires a concrete child-control transport.**
   - v1 must not claim instruction/answer delivery to a running child until a real Pi child can acknowledge an inbox message and emit a child event.
   - The intended mechanism is a required builtin child-control extension loaded into every child run. It polls `inbox.jsonl` inside the child Pi session, injects parent messages via Pi session APIs, and exposes a child-facing `subagent_event` tool for structured `question`, `blocked`, `progress`, and `message.received` events.
   - If that transport is not proven by integration test, non-cancel `subagent_message` must remain disabled for live children and the release is not v1-complete.

3. **Parent/root identity is required.**
   - A top-level Pi session must create a durable root parent identity on session start, even though it is not itself a child run.
   - Direct-child defaults, widgets, wait scopes, subscriptions, and recursion must key off this root identity rather than `parentRunId: null`.

4. **Project definitions are not automatically trusted to load code.**
   - Project-local markdown may define prompts and builtin tool names.
   - Project-local definitions may not load arbitrary path-based skills/extensions by default.
   - Path-based skills/extensions require builtin/user roots or explicit per-run approval. The required child-control extension is builtin package code and is always loaded by the harness.

5. **Tool allowlists must be enforced.**
   - Child Pi launches must disable tools when the resolved allowlist is empty.
   - If an agent definition declares tools, launch with Pi's authoritative allowlist behavior. Phase 0 must confirm whether `--tools <allowlist>` alone is sufficient or whether it composes safely with `--no-tools`.
   - Do not ship a command shape where `--no-tools` silently overrides a non-empty `--tools` allowlist.
   - Use Pi builtin tool names such as `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`; do not use `rg` as a Pi tool name unless it is invoked through `bash`.

6. **Wait cursors and delivery dedupe must be precise.**
   - JSONL offsets advance only through the last complete newline. A partial final line must be reread after it is completed.
   - Multi-run waits use per-run cursors.
   - Terminal `result` and `completed` events coalesce into one wake-up keyed by the terminal result, not two follow-ups.

7. **Delivery polling needs ownership.**
   - Multiple Pi sessions in one repo must not all deliver the same wake-up.
   - Add a parent-session owner lease or an append-only delivery claim log with atomic snapshots before automatic follow-ups are enabled.

## Scope

In scope for v1:

- A new workspace package: `packages/async-subagents`.
- TypeScript ESM implementation consistent with existing `packages/*` conventions.
- A Pi package extension registered through package `pi.extensions`.
- Markdown agent definitions with frontmatter and body prompt.
- Agent definition discovery from project, user, and builtin directories, with project > user > builtin precedence.
- Prompt assembly for isolated Pi child runs using per-run `system.md` and `task.md`.
- A Pi harness that starts child Pi agent processes with explicit isolation flags.
- File-backed run store under a project-local default root.
- Durable run layout matching `design.md`: `status.json`, `inbox.jsonl`, `events.jsonl`, `result.json`, `artifacts/`, `logs/`.
- Parent-to-child messages through `inbox.jsonl`.
- Child-to-parent events through `events.jsonl`.
- Explicit writer ownership:
  - launcher writes pre-spawn setup files and initial status;
  - child-side runtime writes lifecycle/events/result after spawn;
  - parent writes only child inbox messages and delivery metadata.
- One parent writer for each child `inbox.jsonl`.
- Atomic snapshot writes and append-only JSONL readers that tolerate partial final lines.
- Pi tools: `subagent_start`, `subagent_wait`, `subagent_message`, `subagent_result`.
- Pi tools: `subagent_status`.
- Optional Pi tool: `subagent_cancel`, if the required tools are complete first.
- Pi renderers for tool calls/results and automatic wake-up messages.
- Pi footer/status line and below-editor live widget.
- Automatic wake-up polling with dedupe derived from run files and delivery metadata.
- Unit tests for parsing, prompt assembly, run-store behavior, wait semantics, renderer summaries, and wake-up dedupe.
- Integration tests with a fake Pi harness before real-child smoke testing.

Explicitly out of scope for v1:

- Chains, saved workflows, DAGs, or planner semantics.
- Peer intercom or child-to-child messaging.
- Worktree management.
- Slash/TUI agent manager.
- In-terminal agent definition editor.
- Cross-harness support.
- Model fallback.
- Server dependency.
- Compatibility with Tango internal data formats or `pi-subagents` internal data formats.
- Forking parent context by default.
- Global prompt-template bridge.
- Ambient skills, extensions, includes, or context files.
- A global event bus or global work graph.
- In-place compaction of active JSONL files.

## Architecture decision

Use a clean new package named `packages/async-subagents`.

Rationale:

- The primitive is intentionally smaller than Tango and should not grow `packages/tango/extensions/pi/index.ts`.
- `packages/pi-subagents-lite` would describe the host but not the durable primitive. `async-subagents` better captures the spec and leaves room for a CLI/test harness inside the package while keeping v1 Pi-only.
- A new package can include extension tests in its own `tsconfig.json` instead of fighting `packages/tango`'s current `rootDir: "src"` layout.
- The package can keep extension composition split from core file logic: storage, agent definitions, prompt assembly, Pi harness, Pi extension tools, renderers, widget, and wake-ups are separate modules.

The core architecture is:

```txt
Pi parent session
  packages/async-subagents/extensions/pi/index.ts
    registers tools/renderers/session hooks
    starts local wake-up poller and live widget poller
    calls core src APIs

Core file-backed runtime
  src/runStore.ts
    creates and reads run directories
    owns atomic snapshot and JSONL helper logic
  src/start.ts
    resolves agent definition, creates run dir, assembles prompt, spawns supervisor
  src/supervisor.ts
    child-side lifecycle process owns status/result/log writes and lifecycle event appends
  extensions/child-control/index.ts
    required child extension for live inbox delivery and structured child events
  src/wait.ts
    reads events/status/result and implements race/all wait semantics
  src/message.ts
    appends parent-owned inbox messages
  src/result.ts
    reads result and artifact metadata
  src/watcher.ts
    polling-first wake-up detection and live summaries
  src/piHarness.ts
    Pi-only child process invocation

Child Pi agent process
  launched with isolated prompt and explicit opt-ins only
  writes final content through supervisor-captured output/result channel
```

The stable control target is always `runId` and `runDir`. Names and current working directories are display and launch metadata only. Every tool must accept or return `runId`; any path-based lookup is convenience only.

UI is a projection over run files and delivery metadata. It is not a source of truth. If the Pi UI restarts, the run state remains recoverable from the run directory.

## Package layout

Create:

```txt
packages/async-subagents/
  package.json
  tsconfig.json
  README.md
  agents/
    scout.md
    reviewer.md
    worker.md
  extensions/
    child-control/
      index.ts
    pi/
      index.ts
      tools.ts
      renderers.ts
      liveWidget.ts
      wakeups.ts
      statusLine.ts
      schema.ts
  src/
    agentDefinitions.ts
    cli.ts
    config.ts
    errors.ts
    events.ts
    frontmatter.ts
    ids.ts
    jsonl.ts
    message.ts
    piHarness.ts
    promptAssembly.ts
    result.ts
    runStore.ts
    schemas.ts
    start.ts
    status.ts
    supervisor.ts
    time.ts
    types.ts
    wait.ts
    watcher.ts
  test/
    agentDefinitions.test.ts
    frontmatter.test.ts
    jsonl.test.ts
    promptAssembly.test.ts
    runStore.test.ts
    wait.test.ts
    wakeups.test.ts
    renderers.test.ts
    fixtures/
      agents/
        scout.md
        project-scout.md
        bad-frontmatter.md
      fake-pi-child.js
```

Recommended `package.json`:

```json
{
  "name": "@bravo/async-subagents",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Pi-only async subagent primitive with durable run files.",
  "keywords": ["pi-package"],
  "bin": {
    "async-subagents": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "check": "tsc -p tsconfig.json --noEmit",
    "test": "npm run build && node --test dist/test/*.test.js"
  },
  "dependencies": {},
  "devDependencies": {
    "@types/node": "latest",
    "typescript": "latest"
  },
  "peerDependencies": {
    "@mariozechner/pi-ai": "*",
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*",
    "typebox": "*"
  },
  "pi": {
    "extensions": ["./extensions/pi"]
  }
}
```

Recommended `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "types": ["node"],
    "rootDir": ".",
    "outDir": "dist"
  },
  "include": [
    "src/**/*.ts",
    "extensions/**/*.ts",
    "test/**/*.ts"
  ]
}
```

Keep the package standalone. Do not import from `packages/tango` for runtime behavior. Reuse concepts, not code.

## Phase-by-phase plan

### Phase 0: package skeleton, Pi CLI contract, and compile path

Files:

- `packages/async-subagents/package.json`
- `packages/async-subagents/tsconfig.json`
- `packages/async-subagents/README.md`
- empty or minimal module stubs under `src/` and `extensions/pi/`

Implementation:

- Add the package as a normal `packages/*` workspace.
- Configure TypeScript ESM with `NodeNext`.
- Register the Pi extension path in package metadata.
- Export no public API yet beyond compileable stubs.
- Add `src/types.ts` with the core unions and interfaces used by later phases.
- Add `src/errors.ts` with a small `SubagentError` carrying `code`, `message`, and optional `details`.
- Verify the local Pi CLI contract before implementing the harness:
  - `--system-prompt` replacement behavior;
  - `--mode json -p` behavior for oneshot child runs;
  - `@<taskPath>` prompt-file expansion or direct task-string passing;
  - `--no-tools` and `--tools` allowlist behavior;
  - invocation strategy when the parent Pi session is launched from source versus installed binary.

Acceptance criteria:

- `npm run check --workspace @bravo/async-subagents` passes.
- `npm run build --workspace @bravo/async-subagents` passes.
- The root `npm run check` still passes for existing workspaces.
- No changes are made to Tango package code.
- A short local note or test fixture records the confirmed Pi argv shape. Do not proceed to Phase 3 until this is known.

### Phase 1: data contracts, IDs, atomic writes, and JSONL helpers

Files:

- `src/types.ts`
- `src/schemas.ts`
- `src/ids.ts`
- `src/time.ts`
- `src/jsonl.ts`
- `src/runStore.ts`
- `test/jsonl.test.ts`
- `test/runStore.test.ts`

Implementation:

- Define v1 types:
  - `RunState`
  - `TerminalRunState`
  - `EventType`
  - `InboxMessageType`
  - `RunStatus`
  - `RunEvent`
  - `InboxMessage`
  - `RunResult`
  - `ArtifactRef`
  - `WaitCursor`
  - `WaitCursorMap`
  - `SubagentStartResult`
  - `SubagentWaitResult`
  - `DeliverySubscription`
  - `DeliveryMetadata`
  - `RootSessionIdentity`
  - `RootSessionLease`
  - `RunPaths`
- Generate stable IDs:
  - `run_<timestamp-or-random>`
  - `evt_<zero-padded-sequence>`
  - `msg_<timestamp-or-random>`
  - `art_<timestamp-or-random>`
- Implement `nowIso()` and duration helpers.
- Implement `atomicWriteJson(path, value)`:
  - write to a temp file in the same directory;
  - `fsync` when practical;
  - rename to target;
  - never leave partial `status.json` or `result.json` as the target.
- Implement `appendJsonl(path, object)`:
  - append exactly one JSON object plus newline;
  - create the file if missing;
  - do not rewrite existing lines.
- Implement `readJsonl(path, options)`:
  - read from byte offset when provided;
  - parse complete lines only;
  - tolerate and ignore an incomplete final line;
  - return parsed records plus next byte offset and last valid event/message id;
  - advance `nextOffset` only through the last complete newline, never to EOF past an incomplete trailing record.
- Implement `RunStore`:
  - `resolveRunRoot(cwd, configuredRoot?)`
  - `createRunDirectory(input)`
  - `pathsFor(runRef)` where `runRef` is `{ runId }` resolved through an index or `{ runDir }` as a stable fallback
  - `appendRunIndex(record)` mapping `runId` to `runDir`, project root, parent/root identity, and created time
  - `writeStatus(status)`
  - `readStatus(runId)`
  - `appendEvent(runId, event)`
  - `readEvents(runId, cursor?)`
  - `appendInboxMessage(runId, message)`
  - `readInbox(runId, cursor?)`
  - `writeResult(result)`
  - `readResult(runId)`
  - `listDirectChildren(parentRunId)`
  - `listRecentRuns(filter)`
- Default run root:
  - Use `${projectRoot}/.subagents/runs` for v1 unless `ASYNC_SUBAGENTS_HOME` or extension config provides a root.
  - Record the actual `runDir` in every tool result and status.
- Run lookup:
  - every tool accepts `runId`;
  - every tool also accepts `runDir` when ambiguity exists or the run index is unavailable;
  - `runId` lookup must use a durable index, not a cwd-only guess.
- Do not add a global database.

Acceptance criteria:

- Tests prove `status.json` and `result.json` are written atomically.
- Tests prove `readJsonl` ignores a truncated final line and returns the next valid offset.
- Tests prove an incomplete final JSONL line is not skipped after the writer later completes it.
- Tests prove a run directory is created with `inbox.jsonl`, `events.jsonl`, `status.json`, `artifacts/`, and `logs/`.
- Tests prove `result.json` is absent until terminal completion or failure.

### Phase 2: markdown agent definitions

Files:

- `src/frontmatter.ts`
- `src/agentDefinitions.ts`
- `src/config.ts`
- `agents/scout.md`
- `agents/reviewer.md`
- `agents/worker.md`
- `test/frontmatter.test.ts`
- `test/agentDefinitions.test.ts`
- `test/fixtures/agents/*.md`

Implementation:

- Implement a small frontmatter parser compatible with the Tango-style format:
  - file starts with `---`;
  - frontmatter ends at the next standalone `---`;
  - body prompt is all content after frontmatter, trimmed;
  - supports booleans;
  - supports inline arrays like `[read, grep, ls]`;
  - supports simple block arrays;
  - supports trimmed strings;
  - rejects nested maps and complex YAML features for v1 unless explicitly needed.
- Define:
  - `MarkdownAgentDefinition`
  - `ResolvedAgentDefinition`
  - `PromptFragment`
  - `AgentDefinitionSource = "project" | "user" | "builtin"`
- Supported v1 frontmatter fields:
  - `name?: string`
  - `description: string`
  - `model?: string`
  - `tools?: string[]`
  - `skills?: string[]`
  - `extensions?: string[]`
  - `includes?: string[]`
  - `mode?: "oneshot" | "interactive"`
  - `maxRunMs?: number`
  - `maxSubagentDepth?: number`
  - `cwdPolicy?: "inherit" | "explicit" | "sandbox"`
  - `resultFormat?: "text" | "json" | "files"`
- Use filename fallback for `name` when missing:
  - `reviewer.md` becomes `reviewer`;
  - frontmatter `name` wins when present;
  - duplicate names resolve by source precedence.
- Discovery paths:
  - project: `${cwd}/.agents/subagents/*.md`, then `${cwd}/.agents/*.md` if needed;
  - user: `${ASYNC_SUBAGENTS_HOME}/agents/*.md` or `${HOME}/.async-subagents/agents/*.md`;
  - builtin: `packages/async-subagents/agents/*.md`.
- Precedence:
  - project definitions override user definitions;
  - user definitions override builtin definitions;
  - record `source` and `definitionPath` in `status.json`.
- Include fragments:
  - includes are explicit only;
  - an agent definition may list include names or paths;
  - include lookup should be bounded to project/user/builtin include roots;
  - missing includes fail at start with a structured error rather than silently inheriting ambient prompts.
- Skills/extensions:
  - no ambient skills/extensions;
  - builtin and user-root skills/extensions may be declared by agent definitions;
  - project-local path-based skills/extensions are not loaded by default and require explicit per-run approval;
  - the required builtin child-control extension is loaded by the harness for runtime messaging/events and is not controlled by project markdown.

Acceptance criteria:

- Tests prove frontmatter booleans, inline arrays, block arrays, strings, and body prompt parsing.
- Tests prove filename fallback for missing `name`.
- Tests prove project > user > builtin precedence.
- Tests prove missing required `description` fails clearly.
- Tests prove no global prompt templates, context files, skills, extensions, or includes are present unless explicitly declared.
- Tests prove project-local definitions cannot load arbitrary path-based skills/extensions without explicit approval.

### Phase 2.5: root session identity and writer ownership

Files:

- `src/rootSession.ts`
- `src/leases.ts`
- `test/rootSession.test.ts`
- `test/leases.test.ts`

Implementation:

- On Pi extension `session_start`, create or resolve a durable `RootSessionIdentity`.
- Store it under `.subagents/sessions/` or the configured run root:

```json
{
  "schemaVersion": 1,
  "rootSessionId": "root_...",
  "parentRunId": "root_...",
  "cwd": "/repo",
  "createdAt": "2026-05-14T00:00:00.000Z",
  "updatedAt": "2026-05-14T00:00:00.000Z"
}
```

- Use this identity for:
  - default `subagent_wait` direct-child scope;
  - live widget scope;
  - delivery subscriptions;
  - child `parentRunId` and `rootRunId`;
  - recursion depth roots.
- Pass root/parent identity to child processes through environment variables:
  - `ASYNC_SUBAGENTS_ROOT_SESSION_ID`
  - `ASYNC_SUBAGENTS_PARENT_RUN_ID`
  - `ASYNC_SUBAGENTS_RUN_ID`
  - `ASYNC_SUBAGENTS_RUN_DIR`
- Implement an owner lease for automatic wake-up delivery:
  - latest non-expired lease for `(cwd, rootSessionId)` owns follow-up delivery;
  - stale sessions may still read status but must not send wake-up follow-ups;
  - lease snapshots use atomic writes or append-only claims plus compaction outside active writes.
- Define writer roles:
  - `launcher`: creates run directory, prompt artifacts, launch log, initial `status.json`, run index, and spawn-failure result if the supervisor never starts;
  - `child runtime`: supervisor plus required child-control extension; writes child-side lifecycle/events/result after spawn;
  - `parent runtime`: appends to `inbox.jsonl`, updates delivery metadata/leases, and never writes child lifecycle status except launcher-owned spawn-failure paths.

Acceptance criteria:

- Tests prove two root sessions in the same repo do not share direct-child defaults.
- Tests prove latest live owner lease sends a wake-up and stale owners do not.
- Tests prove run records contain root/parent identity even when launched from a top-level Pi session.
- Tests prove writer-role boundaries in normal start, spawn failure, and terminal completion paths.

### Phase 3: prompt assembly and Pi prompt isolation

Files:

- `src/promptAssembly.ts`
- `src/piHarness.ts`
- `test/promptAssembly.test.ts`

Implementation:

- `assemblePrompt(input)` creates run-local prompt files:
  - `runs/<runId>/artifacts/system.md`
  - `runs/<runId>/artifacts/task.md`
  - optional `runs/<runId>/artifacts/includes/*.md` copies or normalized merged fragments
- System prompt content:
  - body prompt from resolved agent definition;
  - explicit include fragments listed by the definition;
  - minimal runtime contract for the child:
    - it is a delegated child agent;
    - it must work only on the assigned task;
    - it must not spawn children unless its effective recursion policy permits it;
    - it reports completion through the normal Pi final answer;
    - if it needs parent input, it should use the exposed child event mechanism or produce the structured marker expected by the supervisor;
    - it must respect file/code safety instructions passed in the task.
  - no parent/global Pi system prompt.
  - no prompt-template bridge.
- Task prompt content:
  - assigned `task`;
  - parent run metadata (`parentRunId`, `rootRunId`, depth);
  - allowed cwd and files;
  - expected result format;
  - inbox instructions for interactive agents.
- Define `PromptAssemblyResult`:
  - `systemPath`
  - `taskPath`
  - `includePaths`
  - `skills`
  - `extensions`
  - `model`
  - `mode`
  - `maxRunMs`
- Implement `buildPiCommand(input)` in `piHarness.ts`.
- Required Pi isolation flags:
  - `--no-session`
  - `--no-context-files`
  - `--no-skills`
  - `--no-prompt-templates`
  - `--no-extensions`
  - `--system-prompt <systemPath>`
  - tool flags:
    - if the resolved agent declares no tools: `--no-tools`;
    - if it declares tools: use the Phase 0-confirmed authoritative allowlist form, expected to be `--tools <comma-separated allowlist>` without `--no-tools` unless Pi proves the combination is safe;
  - explicit `--skill <name-or-path>` entries only for declared skills
  - explicit `-e <extension>` entries only for declared extensions
  - explicit `-e <builtin child-control extension>` always, because it is the transport for live inbox delivery and structured child events
- Include `--model <model>` only when definition/caller provides one and Pi supports the flag.
- Pass `task.md` as the child user prompt according to the current Pi CLI contract.
- Capture the final command in `logs/launch.json` with secrets redacted.
- Do not pass parent conversation history or root session state.
- Use `@<taskPath>` if the confirmed Pi CLI contract treats `@file` as prompt-file expansion. Otherwise pass the task file contents as the prompt string. Do not pass a bare path that Pi would interpret as literal user text.

Acceptance criteria:

- Tests inspect the assembled `system.md` and prove it contains only definition body, explicit includes, and minimal runtime contract.
- Tests inspect `buildPiCommand` and prove all isolation flags are present by default.
- Tests prove declared skills/extensions become explicit command flags.
- Tests prove declared tools become an effective Pi allowlist and omitted tools leave all tools disabled.
- Tests prove no global system prompt or prompt template text is included.

### Phase 4: supervisor and lifecycle

Files:

- `src/supervisor.ts`
- `src/events.ts`
- `src/status.ts`
- `src/start.ts`
- `src/cli.ts`
- `test/runStore.test.ts`
- integration fixture `test/fixtures/fake-pi-child.js`

Implementation:

- `subagent_start` creates the run directory and writes initial `status.json` before spawning the supervisor.
- Initial state flow:
  - `created` after run dir exists;
  - `queued` if spawn is deferred;
  - `running` after child process spawn succeeds;
  - terminal state after result finalization.
- After spawn, the supervisor owns:
  - `status.json`;
  - `result.json`;
  - `logs/stdout.log`;
  - `logs/stderr.log`;
  - `logs/launch.json`.
- Child-side event transport owns `events.jsonl` appends:
  - supervisor appends lifecycle and terminal events;
  - required child-control extension appends structured child events through the same append helper or emits supervisor-parseable markers;
  - parent code never appends child events.
- Parent owns:
  - appending to child `inbox.jsonl`.
- The supervisor writes:
  - `started` event after child spawn;
  - `progress` or `status` events when available from child output or heartbeat;
  - `question` or `blocked` events only through the chosen child event transport: required child-control `subagent_event` tool or supervisor-parsed structured markers;
  - `result` event before or with terminal completion;
  - `completed`, `failed`, `cancelled`, or `expired` event at terminal transition.
- Result finalization order:
  1. capture or synthesize final summary/body;
  2. write `result.json` atomically;
  3. append `result` event with `wake: true`;
  4. update `status.json` with `resultReady: true`;
  5. append terminal event with `wake: false` when a `result` event was emitted for the same terminal result;
  6. write terminal `status.json`.
- If spawn fails after run dir creation:
  - write failed `status.json`;
  - append failed event;
  - write failed `result.json`.
- If spawn fails before run dir creation:
  - return tool error without `runId`.
- Timeouts:
  - `maxRunMs` is enforced by supervisor;
  - on timeout, request graceful cancel where possible;
  - after grace period, terminate process;
  - terminal state becomes `expired` unless the process already produced a terminal result.
- Parent exit:
  - async child continues;
  - supervisor remains responsible for terminal files.
- Recovery:
  - a later status/read operation may detect a terminal-looking run without `result.json` and synthesize a failed recovered result with `error.recovered: true`.

Acceptance criteria:

- Integration test starts a fake child and observes `created`/`running`/`completed`.
- Integration test proves `result.json` exists before final terminal status is visible.
- Integration test proves spawn failure after run dir creation writes failed result.
- Tests prove ordinary parent tools never write child status/events/result after launch; only the launcher may write initial status and spawn-failure files.
- Tests prove `result` and `completed` produce one logical terminal wake-up, not two.
- Integration test proves the required child-control transport can emit a `question` or `message.received` event before live messaging is marked supported.

### Phase 5: required tool APIs

Files:

- `src/start.ts`
- `src/wait.ts`
- `src/message.ts`
- `src/result.ts`
- `extensions/pi/schema.ts`
- `extensions/pi/tools.ts`
- `extensions/pi/index.ts`
- `test/wait.test.ts`

Implementation:

- Register tools with `pi.registerTool`.
- Use TypeBox schemas in `extensions/pi/schema.ts` for Pi parameter validation.
- Tool names:
  - `subagent_start`
  - `subagent_wait`
  - `subagent_message`
  - `subagent_result`
  - `subagent_status`
  - optional later: `subagent_cancel`

`subagent_start`:

- Inputs:
  - `agent`
  - `task`
  - `name?`
  - `mode?: "async" | "sync"`
  - `wait?: "none" | "interesting" | "terminal" | "result"`
  - `cwd?`
  - `files?`
  - `attachments?`
  - `timeoutMs?`
  - `notifyOn?`
  - `maxSubagentDepth?`
  - `runDir?` is not accepted for new starts; starts allocate a new run directory.
- Defaults:
  - `mode: "async"`
  - `wait: "none"` for direct start
  - sync helper behavior through `mode: "sync"` maps to `start` plus `wait`
  - `notifyOn: ["question", "blocked", "result", "completed", "failed", "cancelled", "expired"]`
- Return:
  - `runId`
  - `runDir`
  - `agentName`
  - `state`
  - `started`
  - `waited`
  - `next` suggestions
  - `waitResult?` if waiting was requested.

`subagent_wait`:

- Inputs:
  - `runIds?`
  - `runDirs?`
  - `parentRunId?`
  - `mode?: "race" | "all" | "each"`
  - `until?: "interesting" | "terminal" | "result" | "event"`
  - `eventTypes?`
  - `since?` as a per-run cursor map: `Record<runIdOrRunDir, { eventOffset: number; lastEventId?: string }>`
  - `timeoutMs?`
  - `includeStatus?`
  - `includeResult?`
  - `maxEvents?`
- Defaults:
  - `runIds`: active direct children of current parent run
  - `mode: "race"`
  - `until: "interesting"`
  - `timeoutMs: 300000`
  - `includeStatus: true`
  - `includeResult: true` for terminal events
  - `maxEvents: 20`
- Semantics:
  - race returns when any watched run has interesting events or completion;
  - all returns when all watched runs meet the condition or timeout;
  - each can be implemented as race in v1 if Pi tool API cannot stream partial results;
  - timeouts never cancel children;
  - return cursors for every watched run.

`subagent_message`:

- Inputs:
  - `runId`
  - `runDir?`
  - `type?: "instruction" | "answer" | "cancel" | "pause" | "resume" | "context"`
  - `body`
  - `attachments?`
  - `requiresAck?`
- Defaults:
  - `type: "instruction"`
  - `requiresAck: true` for interactive children;
  - `requiresAck: false` for already terminal read-only paths.
- Behavior:
  - fail clearly if run is terminal and message is not supported;
  - append only to `inbox.jsonl`;
  - for non-cancel live messages, require the child-control transport to be proven active for the target run;
  - if the transport is not active, return a structured `LIVE_MESSAGE_UNSUPPORTED` error instead of pretending delivery happened;
  - return `messageId`, current status, and next action.

`subagent_result`:

- Inputs:
  - `runId`
  - `runDir?`
  - `includeBody?`
  - `includeArtifacts?`
  - `maxBytes?`
- Behavior:
  - read `result.json`;
  - bounded body output by default;
  - include artifact metadata;
  - mark matching wake-up delivery handled in local metadata when called from Pi extension.

`subagent_status`:

- Inputs:
  - `runIds?`
  - `runDirs?`
  - `parentRunId?`
  - `includeEvents?`
  - `includeInbox?`
  - `maxEvents?`
- Behavior:
  - read-only status/recovery surface;
  - default scope is direct children of the current root session identity;
  - returns compact counts plus selected run rows;
  - when `includeEvents` is true, includes bounded recent events and cursors;
  - never sends wake-ups or mutates delivery state.

Acceptance criteria:

- Pi tool schemas compile.
- Unit tests cover wait race, all, timeout, cursors, and interesting event filtering.
- Manual test can start a fake async child, wait on it, message it, and read its result.
- All tool results include `runId`, `runDir` where available, state, and next suggested action.
- Manual test can recover a run with `subagent_status` after restarting the Pi UI or losing the previous tool result.

### Phase 6: Pi renderers, status line, and live widget

Files:

- `extensions/pi/renderers.ts`
- `extensions/pi/liveWidget.ts`
- `extensions/pi/statusLine.ts`
- `extensions/pi/tools.ts`
- `extensions/pi/index.ts`
- `test/renderers.test.ts`

Implementation:

- Register message renderer:
  - `pi.registerMessageRenderer("async-subagent-message", renderSubagentMessage)`
- Add renderers for:
  - start calls/results;
  - wait calls/results;
  - message calls/results;
  - result calls/results;
  - automatic wake-up messages.
- Keep tool cards compact by default and useful when expanded.
- Carry over terminal UI conveniences:
  - footer/status line through `ctx.ui.setStatus`;
  - live below-editor widget through `ctx.ui.setWidget`;
  - collapsed/expanded tool cards;
  - spinners/progress glyphs for active runs;
  - active/blocked/result-ready counts;
  - status glyphs;
  - detail cards over run/event/result files;
  - next-action affordances.
- Suggested status glyphs:
  - running: spinner frame or `~` fallback when animation is unavailable;
  - waiting/question: `?`;
  - blocked: `!`;
  - result ready/completed: `✓`;
  - failed: `x`;
  - cancelled/expired: `-`;
- Status line:
  - `Subagents: 2 active · 1 blocked · 1 result`
  - hidden or compact when no active/recent runs.
- Live widget:
  - placement: `belowEditor`;
  - scope: direct children of the current parent run;
  - summarize descendants only as counts;
  - show active, blocked, and unhandled result-ready runs;
  - show recent terminal runs briefly until handled or aged out;
  - max visible rows by default, for example 4 plus `+N more`;
  - each row includes glyph/spinner, agent name, run name, state, elapsed time, current tool or last activity, summary/needs, and next action.
- Expanded detail card includes:
  - `runId`;
  - `runDir`;
  - `parentRunId` and `rootRunId`;
  - event id and delivery key;
  - status snapshot;
  - result path;
  - artifact list;
  - recent events;
  - suggested tool call.
- Do not build a slash/TUI manager.
- Do not build an agent editor.
- Do not store UI-only state as the coordination contract.

Acceptance criteria:

- Renderer tests pass without requiring a live Pi UI.
- Widget summary can be generated from fixture `status.json` and `events.jsonl`.
- A manual Pi session shows a footer/status line and below-editor widget while a child runs.
- Wait and wake-up results render as cards rather than raw JSON.

### Phase 7: automatic wake-ups and delivery dedupe

Files:

- `src/watcher.ts`
- `extensions/pi/wakeups.ts`
- `extensions/pi/index.ts`
- `test/wakeups.test.ts`

Implementation:

- `subagent_start` records a subscription to the exact `runId`.
- Store delivery metadata under the run root or Pi session-local metadata, for example:

```txt
.subagents/
  delivery/
    <parentRunId>.json
  leases/
    <rootSessionId>.json
```

- Delivery metadata is a cache, not source of truth.
- Subscription record:
  - `parentRunId`;
  - `rootSessionId`;
  - `runId`;
  - `runDir`;
  - `notifyOn`;
  - `createdAt`;
  - `lastDeliveredKeys`;
  - `handledKeys`.
- Wake-worthy events:
  - `question`;
  - `blocked`;
  - `result`;
  - `completed`;
  - `failed`;
  - `cancelled`;
  - `expired`;
  - `status` with `wake: true`;
  - caller-requested `notifyOn` types.
- Delivery keys:
  - `event:<runId>:<eventId>`;
  - `terminal:<runId>:<result.createdAt>` for `result`, `completed`, `failed`, `cancelled`, and `expired` terminal delivery;
  - `status:<runId>:blocked:<status.updatedAt>`.
- Coalescing:
  - if a terminal result exists, terminal delivery uses the `terminal:<runId>:<result.createdAt>` key;
  - terminal `completed` following a `result` event must not create a second follow-up;
  - default UI may still show both records in expanded event history.
- Polling:
  - default interval about 2 seconds in active Pi sessions;
  - back off on repeated errors;
  - use `fs.watch` only as optional latency optimization;
  - correctness comes from rereading durable files.
- Ownership:
  - before sending a follow-up, the poller must acquire or verify the current owner lease for `(cwd, rootSessionId)`;
  - if another live session owns the lease, this poller may update local UI but must not deliver parent follow-ups;
  - lease writes use atomic snapshots or append-only claims.
- Parent wake-up path:
  - call `pi.sendMessage({ customType: "async-subagent-message", content, display: true, details }, { deliverAs: "followUp", triggerTurn: true })` when supported;
  - if unsupported, fall back to UI notify plus visible widget/result card on the next tool call;
  - never delete or consume child events.
- Handling:
  - explicit `subagent_wait` can satisfy delivery for events it returns;
  - `subagent_result` marks terminal/result delivery handled;
  - duplicates are suppressed by delivery key.

Acceptance criteria:

- Test proves the same event is delivered once across repeated polls.
- Test proves explicit wait can mark returned events handled.
- Test proves restart/reload of delivery metadata does not create unbounded duplicate wake-ups for already handled terminal results.
- Test proves two concurrent pollers do not both send the same follow-up.
- Test proves `result` and terminal completion coalesce into one delivery key.
- Manual Pi session receives an automatic follow-up when a child completes while the parent is not waiting.

### Phase 8: optional cancel, cleanup guardrails, and docs

Files:

- `src/status.ts`
- `src/message.ts`
- `extensions/pi/tools.ts`
- `README.md`

Implementation:

- Add `subagent_cancel` if the required tools are stable:
  - append `cancel` message;
  - supervisor attempts graceful cancellation;
  - optional escalation after a grace period;
  - terminal event/status written by supervisor.
- Cleanup policy:
  - no automatic deletion in early v1;
  - document future retention default of 7 to 30 days;
  - cleanup must never delete active, blocked, waiting-for-input, or unhandled-result runs;
  - cleanup removes whole run directories only.
- README:
  - package purpose;
  - Pi-only status;
  - agent definition format;
  - run file layout;
  - tool examples;
  - manual smoke test.

Acceptance criteria:

- Optional tools do not block required tool release.
- Documentation is enough for a developer to define a project-local agent and start it from Pi.
- Cleanup behavior is conservative and cannot remove active or unhandled runs.

## Data contracts

Use schema version `1` on every durable JSON record.

### RunStatus

```ts
type RunStatus = {
  schemaVersion: 1;
  runId: string;
  rootRunId: string;
  parentRunId: string | null;
  rootSessionId: string;
  depth: number;
  maxSubagentDepth: number;
  agent: {
    name: string;
    source: "project" | "user" | "builtin";
    definitionPath: string;
    mode: "oneshot" | "interactive";
  };
  state:
    | "created"
    | "queued"
    | "running"
    | "waiting_for_input"
    | "blocked"
    | "stalled"
    | "completed"
    | "failed"
    | "cancelled"
    | "expired";
  pid: number | null;
  cwd: string;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  lastActivityAt: string | null;
  lastEventId: string | null;
  summary: string | null;
  needs: string | null;
  currentTool: {
    name: string;
    startedAt: string;
  } | null;
  metrics: {
    tokens?: { input?: number; output?: number; total?: number };
    toolCalls?: number;
  };
  resultReady: boolean;
  error: null | {
    code: string;
    message: string;
    details?: unknown;
    recovered?: boolean;
  };
};
```

### RunEvent

```ts
type RunEvent = {
  schemaVersion: 1;
  eventId: string;
  runId: string;
  parentRunId: string | null;
  type:
    | "started"
    | "progress"
    | "status"
    | "message.received"
    | "question"
    | "blocked"
    | "artifact"
    | "result"
    | "completed"
    | "failed"
    | "cancelled"
    | "expired"
    | "heartbeat";
  level: "debug" | "info" | "warning" | "error";
  createdAt: string;
  summary: string;
  body?: string;
  wake: boolean;
  data: Record<string, unknown>;
};
```

### InboxMessage

```ts
type InboxMessage = {
  schemaVersion: 1;
  messageId: string;
  toRunId: string;
  fromRunId: string | null;
  type: "instruction" | "answer" | "cancel" | "pause" | "resume" | "context";
  createdAt: string;
  body: string;
  attachments: AttachmentRef[];
  requiresAck: boolean;
};
```

### WaitCursorMap

```ts
type WaitCursorMap = Record<string, {
  eventOffset: number;
  lastEventId?: string;
}>;
```

Cursor keys are `runId` when available and `runDir` only for fallback lookups. `eventOffset` always points to the byte immediately after the last complete newline that was parsed. It must never skip an incomplete trailing JSONL line.

### AttachmentRef

```ts
type AttachmentRef = {
  kind: "file" | "artifact" | "url";
  path?: string;
  artifactId?: string;
  url?: string;
  mime?: string;
  bytes?: number;
};
```

### DeliverySubscription and Owner Lease

```ts
type DeliverySubscription = {
  schemaVersion: 1;
  subscriptionId: string;
  rootSessionId: string;
  parentRunId: string;
  runId: string;
  runDir: string;
  notifyOn: EventType[];
  createdAt: string;
  lastDeliveredKeys: string[];
  handledKeys: string[];
};

type RootSessionLease = {
  schemaVersion: 1;
  rootSessionId: string;
  ownerId: string;
  cwd: string;
  pid: number;
  heartbeatAt: string;
  expiresAt: string;
};
```

### RunResult

```ts
type RunResult = {
  schemaVersion: 1;
  runId: string;
  parentRunId: string | null;
  agentName: string;
  state: "completed" | "failed" | "cancelled" | "expired";
  success: boolean;
  createdAt: string;
  durationMs: number;
  summary: string;
  body?: string;
  artifacts: ArtifactRef[];
  metrics: {
    tokens?: { input?: number; output?: number; total?: number };
    toolCalls?: number;
  };
  error: null | {
    code: string;
    message: string;
    details?: unknown;
    recovered?: boolean;
  };
};
```

### Writer ownership

Writer ownership is part of the contract:

- Parent runtime writes only `inbox.jsonl` for a child.
- Launcher writes setup artifacts, initial status, run index records, and spawn-failure files before the child-side runtime exists.
- Child-side runtime writes lifecycle `status.json`, `events.jsonl`, `result.json`, `artifacts/`, and `logs/` after spawn. This includes supervisor writes and the required child-control event transport.
- Readers may read any run files.
- No active writer rewrites JSONL history.
- No process compacts active JSONL files.

The design currently uses one `inbox.jsonl` and one `events.jsonl`. A future version may split this into `mail/to-child.jsonl` and `mail/to-parent.jsonl`, but v1 should stay aligned with the design unless implementation reveals a concrete correctness problem.

## Agent definitions

Agent definitions are markdown files:

```md
---
name: scout
description: Read-only repository reconnaissance
model: gpt-5.4-mini
tools: [read, grep, ls]
skills: []
extensions: []
includes: [repo-safety]
mode: oneshot
maxRunMs: 600000
maxSubagentDepth: 0
---

You are a focused reconnaissance agent.

Read only the assigned scope and report concise findings with file references.
```

Key behavior:

- Body prompt is the individualized system prompt basis for that agent.
- `description` is required for help/selection surfaces.
- `name` has filename fallback.
- Tools, skills, extensions, and includes are explicit opt-ins only.
- No definition inherits a global root-session prompt.
- No definition inherits prompt templates.
- No definition inherits context files.
- No definition inherits ambient Pi skills or extensions.
- Effective recursion starts at `0` for children unless definition and parent policy both allow more.
- The resolved definition source and path are recorded in `status.json`.

Builtin starter definitions:

- `scout.md`: read-only reconnaissance, no edits, `maxSubagentDepth: 0`.
- `reviewer.md`: read-only code/spec review, findings-first output, `maxSubagentDepth: 0`.
- `worker.md`: bounded implementation only when explicitly invoked, `maxSubagentDepth: 0`.

Do not add a broad "lead" builtin in v1. This package is the subagent primitive, not the root coordinator.

## Pi harness

The Pi harness is the only v1 execution harness.

Recommended module boundary:

- `src/piHarness.ts`
  - builds the Pi child command;
  - owns isolation flags;
  - normalizes model/skill/extension arguments;
  - redacts launch logs.
- `src/supervisor.ts`
  - spawns the Pi child command;
  - captures stdout/stderr;
  - updates durable files;
  - handles timeout/cancel.

Default launch policy:

```txt
pi
  --no-session
  --no-context-files
  --no-skills
  --no-prompt-templates
  --no-extensions
  --system-prompt <runDir>/artifacts/system.md
  --tools <definition tool allowlist, when non-empty>
  # or: --no-tools when the definition tool allowlist is empty
  -e <builtin child-control extension>
  --skill <explicit skill, repeated>
  -e <explicit extension, repeated>
  [--model <definition model>]
  @<runDir>/artifacts/task.md
```

The exact executable name and task-passing mechanism must be confirmed in Phase 0. If `@<taskPath>` is not accepted by the local Pi CLI, pass the task file contents as the prompt string. Do not pass a bare task path.

Child result capture:

- For oneshot agents, capture final assistant output as the default `result.body`.
- First non-empty line or an explicit structured summary marker becomes `result.summary`.
- If the child emits structured event markers, supervisor converts them to `events.jsonl`.
- If no structured markers appear, supervisor still creates a successful text result from final output on exit code `0`.
- Non-zero exit becomes `failed` with stderr/log references.

Interactive children:

- Supervisor keeps process alive.
- Supervisor polls or tails `inbox.jsonl`.
- Parent messages are delivered to the child according to available Pi stdin/session mechanics.
- If Pi cannot support true interactive child input in the first cut, v1 may support messaging only for supervisor-observed cancellation and document that non-cancel messages require interactive harness completion before release.

This is the highest-risk implementation detail. Do not claim full interactive support until a real Pi child can acknowledge `inbox.jsonl` messages and respond with events.

## Tool APIs

Pi extension tool registration belongs in `extensions/pi/tools.ts`.

Tool rendering belongs in `extensions/pi/renderers.ts`.

Core logic belongs in `src/*` so tests can exercise it without Pi.

Required tool schemas should match the design closely. Tool result shape should favor compact agent-readable summaries plus structured `details`.

Every tool result should include:

- `runId` where applicable;
- `runDir` where applicable;
- `state`;
- concise `summary`;
- structured `details`;
- `next` suggestions.

Example `next` entries:

```json
[
  { "tool": "subagent_wait", "args": { "runIds": ["run_..."] } },
  { "tool": "subagent_message", "args": { "runId": "run_...", "type": "answer" } },
  { "tool": "subagent_result", "args": { "runId": "run_..." } }
]
```

Error behavior:

- Missing agent definition: tool error with `code: "AGENT_NOT_FOUND"`.
- Invalid definition: tool error with `code: "INVALID_AGENT_DEFINITION"`.
- Depth exhausted: tool error with `code: "SUBAGENT_DEPTH_EXHAUSTED"`.
- Terminal run messaged: tool error with `code: "RUN_TERMINAL"`.
- Missing result: tool error with `code: "RESULT_NOT_READY"` unless recovery synthesized a failed result.
- Corrupt JSON snapshots: retry once, then return `code: "RUN_STORE_CORRUPT"` with paths.

## UI implementation

The Pi extension should feel like Tango's convenient terminal integration, but it should be smaller and purpose-built.

Composition root:

- `extensions/pi/index.ts`
  - registers renderers;
  - registers tools;
  - starts wake-up poller on `session_start`;
  - starts live widget poller on `session_start`;
  - updates status line;
  - clears timers on `session_shutdown`.

Renderers:

- `renderSubagentToolCall(args, theme)`
- `renderSubagentToolResult(result, options, theme)`
- `renderSubagentWakeMessage(message, options, theme)`
- `renderRunRow(summary, theme)`
- `renderDetailCard(details, expanded, theme)`

Live widget:

- Poll direct child statuses every 2 seconds while Pi UI is active.
- Use backoff after errors.
- Hide when there are no active, blocked, or unhandled result-ready runs.
- Render rows from `status.json` and recent events only.
- Render counts:
  - active;
  - blocked/waiting;
  - result-ready;
  - failed;
  - descendants summarized.
- Keep text width-safe with truncation helpers.

Status line:

- Use `ctx.ui.setStatus("async-subagents", text)`.
- Examples:
  - `Subagents: ready`
  - `Subagents: 2 active`
  - `Subagents: 2 active · 1 blocked · 1 result`
- Clear or dim it when no relevant runs exist.

Cards:

- Start card:
  - agent name;
  - run name;
  - mode;
  - cwd;
  - task preview.
- Wait card:
  - wait mode;
  - ready run count;
  - event type and summary;
  - remaining run count;
  - next action.
- Wake-up card:
  - event type;
  - agent/run label;
  - summary/body preview;
  - result readiness;
  - next action.
- Result card:
  - terminal state;
  - duration;
  - token/tool metrics if present;
  - summary;
  - artifacts;
  - next action or handled state.

Detail view:

- v1 can implement detail as expanded renderer output and/or `subagent_status({ runId, includeEvents: true })`.
- It must read `status.json`, `events.jsonl`, `result.json`, `inbox.jsonl`, `artifacts/`, and `logs/`.
- Do not create an independent UI state store.

## Automatic wake-ups

Automatic completion surfacing should be implemented after the required file contract and wait semantics are solid.

Flow:

1. `subagent_start` creates the child run and records a subscription for the parent run.
2. `wakeups.ts` poller scans subscribed run dirs.
3. For each run, read new events since the last cursor and current status/result.
4. Determine wake-worthy events from `notifyOn`, default interesting types, and `wake: true`.
5. Build a delivery key.
6. Skip if delivery key is already handled or delivered.
7. Send a Pi follow-up message:

```ts
pi.sendMessage({
  customType: "async-subagent-message",
  content: wakeText,
  display: true,
  details: { runId, runDir, event, status, result }
}, { deliverAs: "followUp", triggerTurn: true });
```

8. Update delivery metadata.
9. Refresh status line and live widget.

Delivery metadata rules:

- It is a dedupe cache, not the truth.
- Losing it may cause at most bounded duplicate wake-ups, not lost run state.
- It should not be required for `subagent_wait`.
- It should be small and per parent/root session.

Interactions with explicit wait:

- If `subagent_wait` returns an event, mark that delivery key handled.
- If `subagent_result` reads a result, mark terminal/result delivery keys handled.
- If a wake-up has already been sent, `subagent_wait` still returns events when requested; delivery dedupe affects follow-up messages only.

## Testing/validation

Unit tests:

- `frontmatter.test.ts`
  - parses required scalar fields;
  - parses booleans;
  - parses inline arrays;
  - parses block arrays;
  - trims body prompt;
  - rejects unsupported nested structures.
- `agentDefinitions.test.ts`
  - filename fallback;
  - project/user/builtin precedence;
  - explicit includes;
  - missing description;
  - no ambient prompt/skill/extension inheritance.
- `promptAssembly.test.ts`
  - writes run-local `system.md` and `task.md`;
  - includes only explicit fragments;
  - omits global system prompt;
  - emits explicit skill/extension lists.
- `jsonl.test.ts`
  - append/read round trip;
  - offset cursor;
  - partial last line ignored;
  - malformed middle line returns structured corruption error or skip behavior per final policy.
- `runStore.test.ts`
  - run directory creation;
  - atomic status write;
  - result write before terminal status transition;
  - list direct children.
- `wait.test.ts`
  - race returns first interesting event;
  - progress does not satisfy default wait;
  - all waits for all selected runs;
  - timeout returns statuses and does not cancel;
  - cursors prevent duplicate events.
- `wakeups.test.ts`
  - delivery key generation;
  - duplicate suppression;
  - handled result suppression;
  - requested `notifyOn` event type.
- `renderers.test.ts`
  - compact cards fit expected text;
  - expanded cards include run paths and next actions;
  - widget counts active/blocked/result-ready correctly.

Integration tests:

- fake child exits success and creates completed result.
- fake child exits non-zero and creates failed result.
- fake child emits question marker and default wait returns it.
- fake child sleeps while `subagent_wait` times out; child remains running.
- fake child receives cancel and terminal state becomes cancelled or expired.

Manual Pi validation:

1. `npm run build --workspace @bravo/async-subagents`
2. `npm run check --workspace @bravo/async-subagents`
3. `npm test --workspace @bravo/async-subagents`
4. Install or load the Pi package locally.
5. Start Pi in a test repo with a project-local `.agents/subagents/scout.md`.
6. Use `subagent_start` with `wait: "none"`.
7. Confirm the parent can keep working.
8. Confirm footer/status line shows active child count.
9. Confirm below-editor widget shows the active child row.
10. Confirm terminal completion sends a follow-up wake-up.
11. Use `subagent_result` and confirm the wake-up becomes handled.
12. Start two fake children and call `subagent_wait` with default race semantics.
13. Confirm the first interesting event returns and the other child keeps running.
14. Send `subagent_message` to an interactive test child and confirm `message.received` or a stronger event appears.

Root validation commands:

```sh
npm run check
npm run build
npm test --workspace @bravo/async-subagents
```

Do not require a server, daemon, or Tango process for tests.

## Rollout and risks

Rollout sequence:

1. Land the package skeleton and core file store behind no active Pi behavior.
2. Land agent definition parsing and prompt assembly.
3. Land fake-harness lifecycle tests.
4. Land Pi extension tools with real run creation but initially conservative rendering.
5. Land live widget/status line.
6. Land automatic wake-ups.
7. Land optional status/cancel tools.
8. Use in a local Pi session against disposable repos before relying on it for real implementation work.

Key risks:

- Pi child invocation contract may differ from the assumed command shape. Validate the real Pi CLI before finalizing `piHarness.ts`.
- True interactive parent-to-child messaging may need Pi runtime support beyond stdin. Treat interactive messaging as a release gate if the user expects answers/instructions to reach a live child.
- Automatic wake-ups can be annoying if dedupe is wrong. Keep delivery keys deterministic and mark explicit wait/result handling.
- Renderer tests can be accidentally excluded if `tsconfig.json` only includes `src`. Use package `rootDir: "."` and include `extensions/**/*.ts` and `test/**/*.ts`.
- Ambiguous run roots can make recovery hard. Always return `runDir` and prefer project-local `.subagents/runs` in v1.
- Prompt isolation is critical. Any use of Pi hooks that appends the parent/global system prompt to child runs violates the main requirement.
- Cleanup can destroy evidence if too eager. Do not implement automatic deletion until active/blocked/unhandled-result detection is reliable.
- Cross-platform process signaling may differ. Keep cancellation tests tolerant but explicit about terminal state.

Non-blocking future considerations:

- Split `inbox.jsonl`/`events.jsonl` into `mail/to-child.jsonl` and `mail/to-parent.jsonl` if writer ownership becomes confusing.
- Add a richer detail command or UI panel after the core cards prove useful.
- Add non-Pi harnesses only after v1 succeeds and only with explicit design updates.
- Add cleanup with retention and pinning after run lifecycle is stable.

v1 is complete when:

- a parent can start an async Pi child and keep working;
- multiple children can be race-waited;
- child completion surfaces automatically;
- the parent can message a running child where Pi supports interactive delivery;
- all run state is recoverable from durable files;
- the UI gives useful live status, result cards, detail affordances, and next actions;
- no behavior requires workflows, chains, peer intercom, worktree management, cross-harness abstraction, or model fallback.
