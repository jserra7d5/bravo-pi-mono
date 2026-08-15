# Onboarding: running the async-subagents setup

This gets you from a fresh clone to delegating work to GPT-5.6 role agents from Claude Code.

## What you need

- Node >= 22.13
- A ChatGPT/Codex subscription (your own — see [Codex auth](#codex-auth) below)
- Claude Code, if you want to drive the agents from Claude rather than the CLI

## 1. Install pi and the workspace

The pi version here is pinned deliberately. The `pi` on your PATH and the copy the workspace
type-checks against must match, or extensions compile clean and fail at runtime — see
[the pi pin](#the-pi-pin).

```sh
npm i -g @earendil-works/pi-coding-agent@0.84.2
git clone https://github.com/jserra7d5/bravo-pi-mono.git
cd bravo-pi-mono
npm install
npm run build
```

Verify:

```sh
pi --version                      # 0.84.2
npm run check                     # whole workspace type-checks
```

## 2. Codex auth

The `bravo-codex-balanced` provider is a **local** balancer over whatever Codex accounts are
authenticated on your own machine. Nothing about anyone else's accounts ships with this repo, and
there is no shared service to join — you point it at your own subscription.

Log in with Codex (or pi) as you normally would, then confirm the balancer sees a slot:

```sh
node packages/codex-auth-balancer/dist/src/cli.js list --json
```

You should see at least one account. Slot state lives under `~/.bravo/codex-auth-balancer/`.

With a single subscription, rotation is a no-op — you still get serialized token refresh (which is
what stops the weekly re-auth breakage) and per-account usage tracking. Multiple accounts enable
cache-affinity routing across them.

## 3. Install the skill

```sh
node packages/async-subagents/dist/src/cli.js install
```

This symlinks `packages/async-subagents/skills/pi-async-subagents` into `~/.claude/skills/`, so
Claude Code picks up `/pi-async-subagents`. Put the CLI on PATH so the skill's commands resolve:

```sh
npm link --workspace @bravo/async-subagents   # or add ./node_modules/.bin to PATH
async-subagents --help
```

## 4. Smoke test

```sh
async-subagents agents --cwd "$PWD"
```

All five roles should list with `"source": "builtin"`. Then run one:

```sh
async-subagents run --cwd "$PWD" --agent scout \
  --task 'Report the "name" field in packages/async-subagents/package.json. One line.'
```

It should come back with `@bravo/async-subagents`.

## The roles

| Role | For | Model |
| --- | --- | --- |
| `scout` | retrieval and source summaries — find and report what is there | Luna |
| `planner` | designs, specs, sequencing | Sol |
| `worker` | bounded implementation against a concrete brief | Sol |
| `reviewer` | merge-risk review against an accepted contract | Sol |
| `generalist` | only when nothing narrower fits | Sol |

Pick the narrowest that fits. `scout` is pinned to Luna on purpose: retrieval is not a judgment
task, so a large read surface is not a reason to escalate.

Read `~/.claude/skills/pi-async-subagents/SKILL.md` before driving these — it carries the operating
rules that matter (write-scope contracts, why you must capture `runId` from `start`, why two write
lanes in one checkout corrupt the tree, and how to judge Sol's output).

## The pi pin

Every package here declares the pi runtime as a `*` peer, so the root `devDependencies` in
`package.json` pin what the workspace type-checks against. Keep that in lockstep with the `pi` on
your PATH. `packages/codex-auth-balancer/scripts/check-pi-ai-drift.mjs` runs in `npm run check` and
fails the build when they diverge — that check exists because a silently-emptied upstream entrypoint
once type-checked clean and threw at runtime for ten days.

One gotcha worth knowing before it bites you. From 0.84.2, `pi-coding-agent` nests its entire
dependency tree privately, so the `@earendil-works/pi-ai` at the workspace root is a **different
file** from the one the host runs. That is fine at runtime: pi's extension loader aliases
`@earendil-works/pi-ai*` to its own copy — but only for extensions it pulls through jiti, meaning the
TypeScript entry named in a package's `pi.extensions`. Load a compiled `dist` entry instead and you
bypass the alias, get a second `pi-ai` instance, and silently break anything built on its
module-local state. `packages/task-plane/test/host.test.ts` has the worked example.

## Upgrading pi

1. `npm i -g @earendil-works/pi-coding-agent@<version>`
2. Bump the four pins in root `package.json` and the `@earendil-works/pi-ai` pin in
   `packages/codex-auth-balancer/package.json` to match
3. `rm -rf node_modules package-lock.json && npm install`
4. `npm run check && npm run build`
5. Run the package suites — `task-plane` and `codex-auth-balancer` are the ones that catch runtime
   API drift rather than type drift
