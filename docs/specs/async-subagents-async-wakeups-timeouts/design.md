# Async Subagents Async Wakeups and Graceful Timeouts Design

Date: 2026-05-28
Status: Draft

## Problem

Async subagents are intended to let the lead Pi session delegate bounded work without blocking the operator. The current model still exposes `subagent_wait` and sync/wait modes, which can block the lead agent inside a long tool call. While that tool call is running, keyboard interrupts and new user input are effectively locked behind the wait.

Terminal wakeups already provide the better orchestration primitive: child runs complete independently, the extension wakes the lead session, and the lead can decide whether to collect or continue the result. To make that the primary path, async-subagents needs consistent completion semantics, safe model-facing wakeup content, rich TUI cards, and graceful runtime budgets.

## Goals

- Remove `subagent_wait` from the model-facing Pi tool surface.
- Make `subagent_start` and terminal `subagent_continue` async-first and non-blocking.
- Use async wakeups as the primary completion path.
- Show all async events with consistent rich TUI cards.
- Do not inject raw child result prose as if it were user input.
- Replace millisecond public runtime budgets with seconds.
- Make runtime budget expiry graceful: preserve in-flight work where possible, ask the child for a checkpoint, and let the parent continue the run if the result is needed.

## Non-Goals

- Redesign the entire async-subagents storage format.
- Add multi-agent DAG orchestration.
- Make child results automatically merged into parent responses.
- Preserve `subagent_wait` as a first-class model-facing compatibility path.

## Current Issues

### `subagent_wait` blocks the lead session

`subagent_wait` is a polling tool with a default long timeout. If the lead agent calls it with a 30 minute timeout and the child takes 30 minutes, the lead session is occupied by the tool call for that period.

This contradicts the value proposition of async subagents. Waiting should be handled by durable runtime wakeups, not by a foreground model tool call.

### Custom wakeups are semantically user messages

Pi custom messages are visually custom but are converted into LLM context as user-role messages. Async-subagents currently sends wakeup content as `wakeup.summary ?? wakeup.title`. If a child result begins with a markdown heading such as `### Summary`, the lead model may infer that the user sent a new summary request.

The issue is not that the parent sees child output. The issue is that the output is not wrapped in a runtime-event envelope.

### Runtime timeout naming is implementation-shaped

`maxRunMs` is public-facing in agent definitions. Milliseconds are convenient for Node `setTimeout()`, but seconds are the human-facing unit. A frontmatter value like `maxRunSeconds: 1800` is clearer than `maxRunMs: 1800000`.

### Runtime timeouts are hard expiry

Today, `maxRunMs` expiry sends `SIGTERM` and marks the run terminal `expired`. That wastes in-flight process context and gives the child no chance to report progress, remaining work, or why more time is needed.

## Target Model

The normal parent flow should be:

1. Lead starts child with `subagent_start`.
2. Tool returns immediately with run identity and launch metadata.
3. Lead continues other work or goes idle.
4. Child emits question/blocked/progress/artifact events or reaches terminal completion.
5. Async-subagents sends a runtime wakeup with a rich TUI card and safe model-facing envelope.
6. Lead decides whether to call `subagent_result`, answer the child, continue a paused timeout, or ignore the run.

No normal flow requires a foreground wait tool.

## Model-Facing Tool Surface

### Remove from model-facing tools

- `subagent_wait`
- `subagent_start.mode: "sync"`
- `subagent_start.wait`
- wait-oriented `subagent_start.timeoutMs`
- `subagent_continue.mode: "sync"`
- `subagent_continue.wait`
- wait-oriented `subagent_continue.timeoutMs`

### Keep / emphasize

- `subagent_start`: start a durable async child and return immediately.
- `subagent_status`: one-shot inspection of current and recent child state; not a polling/waiting path.
- `subagent_result`: collect a terminal result and mark it handled.
- `subagent_message`: answer or send context to a live waiting child.
- `subagent_interrupt`: pause or cancel active child.
- `subagent_continue`: resume paused/timed-out child or create terminal continuation when needed.

### Next suggestions

For a non-terminal start result, do not suggest a follow-up polling action. The parent should continue non-overlapping work or go idle; async wakeups are the completion/attention signal. Use `subagent_status` only for explicit inspection, recovery, or pre-finalization accounting.

For terminal/result-ready wakeups, suggest `subagent_result`.

For question/blocked wakeups, suggest `subagent_message` and optionally `subagent_status`.

## Wakeup Content Semantics

Wakeup content sent to the lead model must be a runtime envelope, not raw child prose.

### Terminal wakeup content

Terminal wakeups should include concise metadata only:

```md
[ASYNC SUBAGENT RESULT READY — NOT USER INPUT]

Subagent: @Mira (reviewer)
Run ID: run_abc123
State: completed
Summary: reviewed the implementation and found no blocking issues

The child result is ready but not included in this wakeup.
Call subagent_result({ runId: "run_abc123" }) if this result is relevant before continuing.
```

For failures/timeouts:

```md
[ASYNC SUBAGENT ATTENTION — NOT USER INPUT]

Subagent: @Mira (reviewer)
Run ID: run_abc123
State: paused
Reason: time budget expired before completion
Summary: inspected renderers.ts and still needs wakeup tests

Continue this run if you need its result, or cancel it if no longer needed.
```

### Raw child body policy

- Do not put full child result body in wakeup `content`.
- Do not put full child result body in wakeup `details` if those details may be included in model context or future summaries.
- Store full body only in `result.json` and expose it through `subagent_result`.
- TUI cards may show a short summary/excerpt, but not the full body.

## Rich TUI Wake Cards

All async events should use the same card grammar.

Required fields when available:

- display name: `@Mira`
- agent role: `reviewer`, `scout/gemini`, etc.
- run ID: `run_abc123`
- state: `completed`, `failed`, `paused`, `blocked`, etc.
- concise summary or need
- suggested action

Example terminal card:

```text
╭─ @Mira · reviewer ─────────────────────── ✓ completed ─╮
▌  run     run_abc123                                      │
▌  state   completed                                       │
▌  result  reviewed implementation; no blockers            │
▌  next    subagent_result to read full result              │
╰──────────────────────────────────────────────────────────╯
```

Example timeout card:

```text
╭─ @Blair · scout/gemini ─────────────────── ⏸ timed out ─╮
▌  run     run_def456                                      │
▌  state   paused                                          │
▌  budget  30m expired                                     │
▌  status  found schema paths; still checking tests         │
▌  next    continue for more time or cancel                 │
╰──────────────────────────────────────────────────────────╯
```

Use existing async-subagents renderer helpers: identity colors, `visWidth`, `truncAnsi`, `chromeRenderable`, and `renderShell: "self"` for tools. Do not use `process.stdout.columns` for cards/widgets.

## Runtime Budget API

### Public unit

Use seconds in public configuration:

```yaml
maxRunSeconds: 1800
```

Convert internally to milliseconds for timers.

### Internal representation

Internal supervisor input can continue using an effective millisecond value, but it should be named as derived runtime data, for example:

```ts
effectiveMaxRunMs: number
```

The user-authored field remains `maxRunSeconds`.

### Effective budget metadata

The effective budget should be visible in:

- launch result details
- `status.json`
- `result.json` or timeout event details
- launch card budget row
- timeout wake card
- launch logs / supervisor input

### Missing budget policy

Use an explicit configured default rather than silent unlimited runtime.

Recommended policy:

- Agent definition may specify `maxRunSeconds`.
- User/global async-subagents config may specify `defaultMaxRunSeconds`.
- If neither exists, fail launch with a clear configuration error.

This keeps bounded agents actually bounded.

## Graceful Timeout Semantics

Timeout should be a two-stage lifecycle: warning checkpoint, then pause.

### Stage 1: soft budget warning

Before the hard deadline, supervisor sends a parent-to-child inbox message through child-control.

Default warning point:

- `min(60 seconds, 20% of maxRunSeconds)` before deadline, with a reasonable lower bound for short test budgets.

Warning message:

```md
Your time budget is nearly exhausted.

Before the deadline, either finish normally or emit a checkpoint with subagent_event:
- current progress
- files/areas already inspected or changed
- remaining work
- whether more time is needed
- why more time is justified

If you cannot finish inside the remaining budget, emit a blocked event requesting continuation.
```

Expected child behavior:

- If nearly done: finish final answer quickly.
- If not done: call `subagent_event({ type: "blocked", summary, body })` with checkpoint and continuation request.

### Stage 2: hard deadline pause

At the hard deadline, preserve work when possible:

1. Send `SIGSTOP` to the child process group.
2. Set status `state: "paused"`.
3. Set `needs` / summary to time budget expired.
4. Append a wake event with reason `TIME_BUDGET_EXPIRED`.
5. Wake parent with a timeout card.

The run is not terminal. It is paused and resumable.

### If pause fails

If the child process is already dead or cannot be stopped:

- fall back to terminal `expired`;
- write `result.json` if stdout/stderr exists;
- include error code `MAX_RUN_SECONDS_EXPIRED` or `TIME_BUDGET_EXPIRED`;
- allow terminal continuation from the recorded Pi session if available.

### Continue semantics

`subagent_continue` on a time-paused run should:

- accept an optional extra budget, e.g. `additionalRunSeconds`;
- append parent instruction/context to inbox;
- send `SIGCONT`;
- move status back to `running`;
- reset or extend the supervisor budget timer.

Example parent message:

```md
Continue with an additional 15 minutes. Prioritize finishing the originally assigned task. If still not complete near the new deadline, emit another checkpoint before blocking.
```

### Cancel semantics

`subagent_interrupt({ action: "cancel" })` remains the way to abandon paused timeout runs. Cancel should transition to terminal `cancelled` and preserve logs/status.

## Checkpoint Event Contract

A timeout checkpoint should be a normal child event, preferably `blocked` when more time is required.

Recommended shape:

```json
{
  "type": "blocked",
  "summary": "Time budget nearly exhausted; need more time to finish renderer tests",
  "body": "Progress: mapped wakeup rendering and removed wait references. Remaining: update piWakeupDelivery tests and run npm test. Need ~10 more minutes.",
  "data": {
    "reason": "time_budget_nearly_exhausted",
    "estimatedAdditionalSeconds": 600,
    "progress": ["mapped wakeup rendering", "removed wait references"],
    "remaining": ["update tests", "run validation"]
  }
}
```

The runtime should not require this exact JSON shape to function, but prompt guidance should teach children to provide this information.

## State Model

No new terminal state is required.

Use:

- `paused` for hard budget pause when process is preserved.
- `expired` for hard budget failure when process cannot be preserved.
- `blocked` / `waiting_for_input` when the child proactively asks for more time before the hard deadline.

Add structured reason fields in events/status/error data rather than new states:

- `TIME_BUDGET_WARNING`
- `TIME_BUDGET_EXPIRED`
- `MAX_RUN_SECONDS_EXPIRED`

## Implementation Surface

Likely files:

- `packages/async-subagents/src/agentDefinitions.ts`
  - parse `maxRunSeconds` instead of `maxRunMs`.
  - variant merge for seconds.
- `packages/async-subagents/src/promptAssembly.ts`
  - include budget in child prompt metadata.
  - add timeout checkpoint behavior to runtime contract.
- `packages/async-subagents/src/start.ts`
  - compute effective budget.
  - remove wait/sync result path from model-facing start.
  - propagate effective budget to supervisor/status/launch logs.
- `packages/async-subagents/src/supervisor.ts`
  - implement soft warning timer.
  - implement hard pause timer.
  - retain fallback terminal expiry.
  - support budget extension on continue, or delegate timer control to a supervisor-side control file.
- `packages/async-subagents/extensions/child-control/index.ts`
  - ensure warning inbox messages are delivered promptly.
- `packages/async-subagents/extensions/pi/tools.ts`
  - remove `subagent_wait` tool.
  - make start/continue async-only.
  - update continue to accept added runtime budget.
- `packages/async-subagents/extensions/pi/schema.ts`
  - remove wait schema and wait params.
  - add `additionalRunSeconds` to continue if desired.
- `packages/async-subagents/extensions/pi/wakeups.ts`
  - make terminal wakeup payload compact and body-free.
  - add timeout-paused event delivery shape.
- `packages/async-subagents/extensions/pi/renderers.ts`
  - rich event cards for terminal, paused timeout, blocked/question.
- `packages/async-subagents/extensions/pi/promptModule.ts`
  - remove wait guidance.
  - describe wakeups/status/result path.
- `packages/async-subagents/extensions/pi/compactionReminder.ts`
  - remove `subagent_wait` guidance.
- `packages/async-subagents/README.md`
  - update public tool and timeout semantics.

## Supervisor Control Consideration

Pausing via `SIGSTOP` means the child process is preserved, but the supervisor process must also remain alive to manage resume timers. If the current supervisor exits immediately after marking a terminal state, the new paused-timeout flow should instead keep supervisor state durable.

Possible implementation options:

1. **Supervisor stays alive while paused**
   - simplest runtime control;
   - parent continue sends a control file/inbox signal;
   - supervisor observes resume and reinstalls timers.

2. **Parent owns resume timers after pause**
   - supervisor pauses child and exits;
   - parent continue sends `SIGCONT` and starts a new watchdog monitor/supervisor;
   - more complex and easier to orphan.

Recommended: supervisor remains owner of child process lifecycle while paused.

## Testing Strategy

### Unit / contract tests

- Agent definitions parse `maxRunSeconds` and reject/ignore `maxRunMs` depending on migration policy.
- Start computes effective budget from definition/config.
- Missing budget fails with clear error when no default exists.
- Wakeup payload excludes full child result body.
- Wakeup model-facing content begins with runtime envelope.
- Wake card renders display name, role, run ID, state, summary, and next action at narrow widths.

### Runtime tests

- Fake child finishing before budget completes normally.
- Fake child receives soft warning and emits checkpoint.
- Fake child exceeding budget is paused, not terminal, when pause succeeds.
- Parent `subagent_continue` resumes paused child with added budget.
- Pause failure falls back to terminal `expired`.
- Cancel from paused timeout transitions to `cancelled`.

### Regression tests

- Registered tools do not include `subagent_wait`.
- Prompt module does not mention `subagent_wait` or wait tools.
- Compaction reminder says `subagent_result` for results, `subagent_message` for blocked/question states, and may suggest one `subagent_status` call for post-compaction orientation, but must not tell the agent to poll active runs.
- Existing wakeup dedupe still delivers terminal/paused events once.

## Validation Commands

```bash
npm run check --workspace @bravo/async-subagents
npm run build --workspace @bravo/async-subagents
npm test --workspace @bravo/async-subagents
```

## Open Questions

- Should `maxRunMs` be accepted temporarily with a deprecation warning, or removed cleanly?
- What default `defaultMaxRunSeconds` should user config use for scouts, reviewers, and workers?
- Should budget extension be a field on `subagent_continue`, or just encoded in the continuation body?
- How long should paused timeout runs be retained before automatic cleanup/cancel?
- Should soft-warning checkpoint be mandatory for child prompts, or best-effort guidance?
