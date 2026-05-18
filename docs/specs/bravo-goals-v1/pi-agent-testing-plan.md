# Bravo Goals Pi Agent Testing Plan

Status: draft  
Date: 2026-05-17  
Scope: Manual and semi-automated validation for an agent running inside Pi with the `@bravo/goals` package installed.

## Purpose

This plan verifies the Pi-facing behavior that Node tests cannot fully prove:

- `/goal` command dispatch works in an interactive Pi session.
- The HUD renders from `.bravo/runtime/active-goals.yaml` and `state.yaml`.
- Goal state lives at a workspace-level `.bravo/` above repos.
- Pause/resume/fresh-session/compact flows respect Pi runtime constraints.
- Archive and verify gates refuse weak or forged completion state.
- Judge control tools write durable run artifacts when run inside an isolated Judge Pi process.

## Preconditions

From the repo root:

```sh
cd /home/joe/Documents/projects/bravo-pi-mono
npm run build --workspace @bravo/goals
npm test --workspace @bravo/goals
pi install /home/joe/Documents/projects/bravo-pi-mono/packages/bravo-goals
pi list
```

Expected:

- `npm test --workspace @bravo/goals` passes.
- `pi list` includes `packages/bravo-goals`.

## Test Workspace

Use a disposable workspace outside the package repo:

```sh
export BRAVO_GOALS_TEST_ROOT=/tmp/bravo-goals-pi-test
rm -rf "$BRAVO_GOALS_TEST_ROOT"
mkdir -p "$BRAVO_GOALS_TEST_ROOT/repo-a"
cd "$BRAVO_GOALS_TEST_ROOT"
bravo-goals init --workspace-root "$BRAVO_GOALS_TEST_ROOT"
bravo-goals prep pi-smoke --workspace-root "$BRAVO_GOALS_TEST_ROOT" --title "Pi Smoke Goal"
```

Expected files:

```txt
$BRAVO_GOALS_TEST_ROOT/.bravo/config.yaml
$BRAVO_GOALS_TEST_ROOT/.bravo/goals/pi-smoke/goal.md
$BRAVO_GOALS_TEST_ROOT/.bravo/goals/pi-smoke/context.md
$BRAVO_GOALS_TEST_ROOT/.bravo/goals/pi-smoke/state.yaml
$BRAVO_GOALS_TEST_ROOT/.bravo/goals/pi-smoke/receipts/
$BRAVO_GOALS_TEST_ROOT/.bravo/goals/pi-smoke/artifacts/
```

`resume.md` should not exist after prep. It is created by the first checkpoint
or pause.

## Test 1: Extension Discovery From Nested Repo

Start Pi from inside a nested repo directory:

```sh
cd "$BRAVO_GOALS_TEST_ROOT/repo-a"
pi
```

Inside Pi:

```txt
/goal start pi-smoke
```

Expected:

- Pi finds the ancestor `.bravo/config.yaml`.
- It does not create `repo-a/.bravo/`.
- `.bravo/runtime/active-goals.yaml` contains `pi-smoke`.
- `.bravo/goals/pi-smoke/state.yaml` has `goal.status: active`.
- HUD/footer shows the goal title, state, active task/progress, and Judge status.

Fail if:

- `/goal start` reports no goal when the ancestor workspace exists.
- A repo-local `.bravo/` appears.
- HUD attaches to a different active goal.

## Test 2: Status And HUD Projection

Inside the same Pi session:

```txt
/goal status
```

Expected:

- Status notification names `Pi Smoke Goal`.
- HUD still renders from files.
- If the current Pi session id does not match `active-goals.yaml`, HUD should not fall back to another active goal.

File checks:

```sh
cat "$BRAVO_GOALS_TEST_ROOT/.bravo/runtime/active-goals.yaml"
cat "$BRAVO_GOALS_TEST_ROOT/.bravo/goals/pi-smoke/state.yaml"
```

## Test 3: Pause Writes Controller Resume

Inside Pi:

```txt
/goal pause pi-smoke --reason "manual Pi smoke"
```

Expected:

- `.bravo/goals/pi-smoke/resume.md` is updated immediately by the controller.
- `state.yaml` has `goal.status: paused`.
- `state.yaml` has `pause.paused_at` and `pause.pause_reason`.
- `active-goals.yaml` no longer binds this session to `pi-smoke`.
- HUD clears.

Fail if pause only queues an agent prompt and leaves `resume.md` unchanged.

## Test 4: Resume Reattaches And Queues Restart Prompt

Inside Pi:

```txt
/goal resume pi-smoke
```

Expected:

- `state.yaml` returns to `goal.status: active`.
- `session.attached_pi_session_id` is set.
- `active-goals.yaml` rebinds the current Pi session.
- A restart prompt is queued that tells the worker to read `goal.md`, `context.md`, `state.yaml`, and `resume.md` if it exists.
- HUD reappears.

## Test 5: Compact Boundary

Prepare a state with a passed Judge receipt or use an existing test goal whose `judge.last_verdict` is `pass` and `judge.last_receipt` points to a completed task Judge receipt.

Inside Pi:

```txt
/goal next pi-smoke --compact
```

Expected:

- `phase_boundary.last_boundary_mode: compact`.
- The compact instructions mention the active goal and durable state path.
- The next prompt is queued only after Pi compaction completes.

Fail if:

- The command proceeds when `judge.last_verdict` is not `pass`.
- The command uses the next active task's boundary rather than the just-passed task's Judge receipt.

## Test 6: Fresh Session Boundary

Prepare the same passed-Judge state as Test 5.

Inside Pi:

```txt
/goal next pi-smoke --fresh
```

Expected:

- Pi creates a replacement session.
- The old command context is not reused after replacement.
- `state.yaml.session.attached_pi_session_id` updates to the replacement session id when Pi exposes it.
- `active-goals.yaml` updates to the replacement session id.
- The replacement session receives the restart prompt.

Residual risk:

- This is the most important live Pi test because Node tests cannot prove the exact interactive session replacement behavior.

## Test 7: Archive And Verify Gates

From shell, try to verify/archive a weak goal:

```sh
cd "$BRAVO_GOALS_TEST_ROOT"
bravo-goals verify pi-smoke --note "should fail"
bravo-goals archive pi-smoke
```

Expected:

- `verify` fails unless every task is done and final audit has a terminal passing Judge run.
- `archive` fails unless status is `done`, final audit passed, user verification exists, session is detached, and `checkGoal` passes.

Fail if manually setting `final_audit.status: passed` is enough to verify/archive without a matching Judge run and receipt.

## Test 8: Judge Run Contract

Create a Judge run through the CLI/library path or a small one-off Node script that calls `createJudgeRun`.

Expected run directory:

```txt
.bravo/runs/judge_<id>/
  run.json
  status.json
  events.jsonl
  verdict.json
  receipt.md
  prompt/system.md
  prompt/task.md
  pi-session/session.jsonl
  home/.pi/agent/
  logs/
  artifacts/
```

Expected:

- `run.json.command_policy.mode` defaults to `judge_bash`.
- Raw `bash` is rejected unless `unsafe_raw_bash: true`.
- `validateJudgeCompletion` rejects non-terminal status.
- `validateJudgeCompletion` rejects receipt/verdict disagreement.

## Test 9: Judge Control Tool In Pi

Run an isolated Pi Judge process with `BRAVO_JUDGE_RUN_DIR` set and the Bravo Goals extension loaded.

Inside that Judge Pi process, call `judge_finish` with:

```json
{
  "goal_id": "pi-smoke",
  "verdict": "pass",
  "receipt_path": ".bravo/goals/pi-smoke/receipts/final-audit.md",
  "summary": "Smoke final audit passed."
}
```

Expected:

- `verdict.json` is written.
- Judge receipt is written.
- `status.json` becomes terminal.
- `events.jsonl` records completion.
- Pi shutdown is requested after durable writes.

Fail if `judge_finish` reports success without `BRAVO_JUDGE_RUN_DIR`.

## Test 10: Multi-Goal Safety

Create two goals:

```sh
bravo-goals prep second-goal --workspace-root "$BRAVO_GOALS_TEST_ROOT"
```

Attach one Pi session to `pi-smoke`. Start another Pi session but do not attach it.

Expected:

- The unattached session does not display the first active goal's HUD.
- `/goal status` without an explicit goal in the unattached session reports no attached Bravo goal.
- Explicit `/goal status pi-smoke` still works.

Fail if the extension falls back to the first active goal for an unrelated session.

## Cleanup

```sh
rm -rf "$BRAVO_GOALS_TEST_ROOT"
```

## Required Report

The testing agent should write a short report with:

- Pi version and `pi list` output showing `packages/bravo-goals`.
- Commands run.
- Pass/fail per test.
- Any screenshots or copied HUD text for HUD tests.
- Paths to generated `.bravo/` artifacts.
- Any runtime mismatches between CLI behavior and Pi extension behavior.

## Pass Criteria

The implementation is Pi-smoke-ready when:

- All Node validation still passes.
- Tests 1-7 and 10 pass in an interactive Pi session.
- Test 8 passes through the contract layer.
- Test 9 either passes or records a concrete implementation blocker for the isolated Judge process path.
