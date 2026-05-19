# @bravo/goals

Pi-first durable goal workspaces for long-running agent work.

Bravo Goals stores goal state above repos under a workspace `.bravo/` directory:

```txt
.bravo/
  goals/<goal-id>/
    goal.md
    context.md
    state.yaml
    receipts/
    artifacts/
    resume.md       # created by checkpoint or pause, not prep
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

`prep` scaffolds the draft goal shell, including `goal.md`, `context.md`,
`state.yaml`, `receipts/`, and `artifacts/`. It does not derive a title from
the goal id, and it does not create `resume.md`; `resume.md` is created by the
first checkpoint or pause when there is an actual stopping point to preserve.
Workspace creation is explicit; the CLI will not silently create a repo-local
`.bravo/` from a nested cwd.

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
`state.yaml` plus `.bravo/runtime/active-goals.yaml`. Idle-recovery prompts are
also gated by fresh durable state: the watchdog re-reads `state.yaml` before
sending and suppresses recovery if the active task has advanced or the goal is
complete.

`/goal prep` is interactive. It creates a draft goal workspace, then queues a
prep prompt that tells the agent to read the placeholders and talk with you
before drafting goal content. The goal id is only the stable slug used for
paths and tools; the agent must not infer scope from it. `--title` is accepted
as a working title, but the agent should confirm or refine it during prep. Prep
does not attach the session, create `resume.md`, or start implementation; use
`/goal start` after the draft goal is ready.

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
