# @bravo/goals

Pi-first durable goal workspaces for long-running agent work.

Bravo Goals stores goal state above repos under a workspace `.bravo/` directory:

```txt
.bravo/
  goals/<goal-id>/
    goal.md
    context.md
    state.yaml
    resume.md
    receipts/
    artifacts/
  runtime/active-goals.yaml
  runs/
  archived/goals/
```

The durable filesystem is the source of truth; the Pi HUD and session prompts
are projections over that state. The Pi extension exposes the primary workflow
through `/goal` slash commands.

## CLI

```sh
bravo-goals init --workspace-root ~/Documents/Quantiiv
bravo-goals prep durable-resume-loop --workspace-root ~/Documents/Quantiiv
bravo-goals status durable-resume-loop
bravo-goals check durable-resume-loop
bravo-goals next durable-resume-loop --fresh
bravo-goals verify durable-resume-loop --note "User verified"
bravo-goals archive durable-resume-loop
```

`prep` scaffolds every required goal entry, including `resume.md`, `receipts/`,
and `artifacts/`. Workspace creation is explicit; the CLI will not silently
create a repo-local `.bravo/` from a nested cwd.

## Pi Extension

Install or load the package as a Pi extension, then use:

```txt
/goal help [subcommand]
/goal init [--workspace-root <path>]
/goal prep <goal-id> [--title "..."]
/goal start <goal-id-or-path>
/goal status [goal-id]
/goal pause [goal-id]
/goal resume <goal-id-or-path>
/goal checkpoint [goal-id]
/goal check [goal-id]
/goal next [goal-id] [--carry | --compact | --fresh]
/goal compact [goal-id]
/goal verify <goal-id> [--note "..."]
/goal archive <goal-id> [--force --reason "..."]
```

The extension renders a footer status and a below-editor HUD from
`state.yaml` plus `.bravo/runtime/active-goals.yaml`.

`/goal prep` is interactive. It creates a draft goal workspace, then queues a
prep prompt so the agent can work with you to clarify the problem, fill
`goal.md` and `context.md`, and write the initial task queue into `state.yaml`.
It does not attach the session or start implementation; use `/goal start` after
the draft goal is ready.

Prep agents should call the native `validate_goal_state` Pi tool after editing
`state.yaml`. The tool validates the state shape and returns a compact issue
list without mutating goal state.

## Judge Contract

Judge runs are Bravo-owned run directories under `.bravo/runs/judge_*`.
`verdict.json` is machine-authoritative, and a Judge receipt must agree with the
run id, task id, verdict, verdict path, and receipt path.

Raw Pi `bash` is unsafe experimental mode only. The default contract uses
`judge_bash` or controller-run verification commands so Judge command execution
has a real policy boundary.

## Validation

```sh
npm run check --workspace @bravo/goals
npm test --workspace @bravo/goals
npm run check
npm run build
```
