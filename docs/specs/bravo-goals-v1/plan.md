# Bravo Goals v1 Implementation Plan

Status: draft  
Date: 2026-05-17

## Sources

This plan synthesizes:

- [design.md](./design.md)
- [research-pi-runtime.md](./research-pi-runtime.md)
- [research-terminal-ui.md](./research-terminal-ui.md)
- [research-package-structure.md](./research-package-structure.md)
- [research-judge-runtime.md](./research-judge-runtime.md)
- [contracts.md](./contracts.md)

## Implementation Position

Build `packages/bravo-goals` as a Pi-first package with a CLI/core library and a Pi extension wrapper.

The main Pi session is the worker. Judge runs are Bravo-owned isolated Pi process executions. Phase boundaries are configurable across `carry`, `compact`, and `fresh_session`; the default after Judge pass should be `fresh_session`.

The durable source of truth is the `.bravo/` filesystem, not Pi transcript history and not UI state.

## Package Skeleton

Create:

```txt
packages/bravo-goals/
  package.json
  tsconfig.json
  README.md
  src/
  extensions/pi/
  docs/templates/
  test/
```

Use:

- package name `@bravo/goals`;
- binary `bravo-goals`;
- Pi extension export under `extensions/pi`;
- `build`, `check`, and `test` scripts matching other real packages.

Reference: [research-package-structure.md](./research-package-structure.md).

## Milestone 1: Core Filesystem and State

Deliverables:

- workspace discovery: find or create `.bravo/` from current cwd;
- goal path resolution by id or explicit path;
- goal scaffold templates;
- `state.yaml` parser/writer;
- atomic writes for state and runtime index;
- checker for required files and schema.

Files likely involved:

```txt
src/workspace.ts
src/state.ts
src/checker.ts
src/receipts.ts
docs/templates/
test/workspace.test.ts
test/state.test.ts
test/checker.test.ts
```

Validation:

```txt
npm run check --workspace @bravo/goals
npm test --workspace @bravo/goals
```

Acceptance:

- can scaffold a goal workspace;
- scaffold always creates `goal.md`, `context.md`, `state.yaml`, `resume.md`, `receipts/`, and `artifacts/`;
- workspace creation is explicit and does not silently create repo-local `.bravo/` from nested cwd;
- can validate `goal.md`, `context.md`, `state.yaml`;
- can reject missing receipts for done tasks;
- can compute progress from task list.

## Milestone 2: CLI

Deliverables:

- `bravo-goals init`
- `bravo-goals prep` scaffold support
- `bravo-goals status`
- `bravo-goals check`
- `bravo-goals archive`
- `bravo-goals judge start/status/result` stubs

Files:

```txt
src/cli.ts
src/index.ts
test/cli.test.ts
```

Acceptance:

- CLI can operate without Pi;
- checker is runnable from CLI and tests;
- archive refuses unless done + final audit + user verification, unless forced.

## Milestone 3: Pi Extension Commands

Deliverables:

- register `/goal` commands;
- attach current Pi session to a goal;
- inject worker prompts;
- checkpoint/pause/resume commands;
- phase boundary command handling;
- session replacement through command-context `newSession`.

Important implementation constraints:

- `newSession`, `switchSession`, `fork`, `reload`, and `waitForIdle` are command-context only.
- `fresh_session` must use `withSession`; old context is stale after replacement.
- no public transcript wipe API exists.

Reference: [research-pi-runtime.md](./research-pi-runtime.md).

Files:

```txt
extensions/pi/index.ts
extensions/pi/commands.ts
src/phase-boundary.ts
test/extension.test.ts
test/phase-boundary.test.ts
```

Acceptance:

- `/goal start <id>` attaches the session and queues a worker prompt;
- `/goal pause` writes or refreshes `resume.md` and detaches;
- pause does not assume `pi.sendUserMessage` is awaitable; agent-authored checkpoints need an explicit later receipt/handshake;
- `/goal next --carry` queues next prompt in same session;
- `/goal next --compact` calls Pi compaction and queues continuation only after compaction completion;
- `/goal next --fresh` creates a replacement session and injects restart prompt.

## Milestone 4: Terminal HUD

Deliverables:

- footer status via `ctx.ui.setStatus("bravo-goals", ...)`;
- below-editor widget via `ctx.ui.setWidget("bravo-goals-hud", ..., { placement: "belowEditor" })`;
- polling loop with `inFlight` guard;
- shutdown cleanup.

Reference: [research-terminal-ui.md](./research-terminal-ui.md).

Files:

```txt
extensions/pi/hud.ts
extensions/pi/renderers.ts
test/extension.test.ts
```

Acceptance:

- HUD shows goal title, lifecycle status, active task, progress, and last Judge verdict;
- HUD renders from `state.yaml` and runtime index;
- HUD clears on detach/session shutdown;
- no custom footer replacement in v1.

## Milestone 5: Worker Receipts and Task Advancement

Deliverables:

- worker receipt template and validation;
- command/tool path to mark worker receipt ready;
- task transition from active work to judging;
- state update logic for Judge pass/fail outcomes.

Acceptance:

- worker cannot mark final goal done directly;
- done task without worker receipt fails validation;
- Judge-passed task without Judge receipt fails validation.

## Milestone 6: Bravo-Owned Judge Runner Spike

Deliver one complete Judge run before building helpers.

Deliverables:

- `.bravo/runs/judge_<id>/` creation;
- `run.json`;
- prompt rendering;
- isolated Pi process launch;
- stdout/stderr logs;
- `status.json`;
- `events.jsonl`;
- `verdict.json`;
- Judge receipt validation;
- timeout/cancel terminal state.
- Judge control extension with `judge_event` and `judge_finish`.

Reference: [research-judge-runtime.md](./research-judge-runtime.md).

Files:

```txt
src/judge-runner.ts
extensions/pi/judge-control.ts
test/judge-runner.test.ts
```

Acceptance:

- launch isolated Pi;
- load Bravo Judge control extension;
- Judge calls `judge_finish`;
- `verdict.json` and receipt are written;
- process exits cleanly;
- controller updates `state.yaml.session.current_judge_run_id` and `judge.last_verdict`.

## Milestone 7: Judge Command Policy

This is the highest-risk area.

Problem: Pi `--tools` allowlists tools, not shell commands. If Judge has `bash`, prompt-only non-mutation rules are not a hard boundary.

V1 options:

1. Build a Bravo `judge_bash` wrapper or policy extension.
2. Start with read-only Judge and explicit verification commands only.
3. Allow raw `bash` only as an unsafe experimental mode.

Recommendation:

- spike option 1 early;
- if too large, ship option 2 first;
- raw `bash` must require `unsafe_raw_bash: true` and make the risk visible in `state.yaml`, receipts, and HUD/status output.

Acceptance:

- every command run by Judge is recorded;
- command records include cwd, exit code, and stdout/stderr artifact paths;
- Judge receipt and verdict include command evidence;
- helper runs default to read-only.

## Milestone 8: Final Audit, Verify, Archive

Deliverables:

- final Judge audit command;
- `user_verification` command;
- archive move;
- `archive.md`;
- archive validation.

Acceptance:

- archive refuses incomplete goals;
- archive refuses missing user verification unless forced;
- forced archive records reason;
- archived goal preserves all durable files.

## Implementation Order

1. Package skeleton.
2. Core state/checker/templates.
3. CLI check/status/scaffold.
4. Pi `/goal start/status/pause/resume`.
5. HUD.
6. Phase boundary modes.
7. Worker receipts/task advancement.
8. Judge runner spike plus Judge control extension.
9. Judge command policy.
10. Final audit/verify/archive.

## Validation Strategy

Run throughout:

```txt
npm run check --workspace @bravo/goals
npm test --workspace @bravo/goals
```

Before integration completion:

```txt
npm run check
npm run build
```

Manual Pi smoke:

```txt
pi -e packages/bravo-goals/extensions/pi/index.ts
```

Specific manual flows:

- scaffold goal;
- start goal;
- pause/resume;
- run `carry`;
- run `fresh_session`;
- run `compact`;
- run Judge spike;
- test receipt/verdict disagreement;
- test final audit gating and archive collision/forced archive behavior;
- test stale runtime index recovery;
- test workspace-root discovery from nested repo paths;
- verify/archive.

## Open Risks

- Judge command policy is not hardened until `judge_bash` or controller-run verification commands are implemented; raw `bash` remains unsafe experimental only.
- Need to prove `judge_finish` plus `ctx.shutdown()` cleanly exits non-interactive Pi.
- Need to confirm Pi prompt file semantics for `--system-prompt` and `--append-system-prompt`.
- Need to keep `resume.md` narrative enough to preserve compaction-like nuance without becoming stale doctrine.
- Need to prevent HUD state from drifting from files.
- Need to avoid turning this into a general workflow engine before the goal loop works.
