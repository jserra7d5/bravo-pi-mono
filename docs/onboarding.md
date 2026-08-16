# Onboarding: running the async-subagents setup

This gets you to delegating work to GPT-5.6 role agents from Claude Code.

Use it as a **user** if you just want the tools. Use the [contributor setup](#contributor-setup) if
you are going to change them.

## What you need

- Node >= 22.13
- A ChatGPT/Codex subscription (your own — see [Codex auth](#2-codex-auth) below)
- Claude Code, if you want to drive the agents from Claude rather than the CLI

## 1. Install

```sh
npm i -g @earendil-works/pi-coding-agent@0.84.2
pi install git:github.com/jserra7d5/bravo-pi-mono
```

That is the whole install. pi clones the repo into its own package directory, runs the build, and
registers the extensions listed in the root `pi.extensions`: async-subagents, the Codex balancer,
web-evidence-cache, and gemini-code-assist.

**Do not add a `#ref` to that source.** A ref makes pi treat the package as pinned and it stops
checking for updates — the no-ref form tracks the repo's default branch, which is the release
channel. See [updates](#updates).

Verify:

```sh
pi --version                                   # 0.84.2
pi list                                        # the package is registered
pi --list-models bravo-codex-balanced          # the balancer's models resolve
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

## 3. Install the Claude Code skill

pi registers extensions for pi. The `pi-async-subagents` skill is for Claude Code, so it needs one
more step:

```sh
PKG="$(pi list | awk '/bravo-pi-mono/{getline; print $1; exit}')"
node "$PKG/packages/async-subagents/dist/src/cli.js" install
ln -sf "$PKG/packages/async-subagents/dist/src/cli.js" ~/.local/bin/async-subagents
```

`install` **symlinks** the skill rather than copying it, so it points into the copy pi manages. That
means `pi update` refreshes the skill too — you do not re-run this after an update.

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

## Updates

pi checks its installed packages for updates when an interactive session starts and tells you which
ones have one waiting. To take it:

```sh
pi update --extensions
```

That fetches, resets to the new commit, reinstalls, and rebuilds. The Claude Code skill comes along
because it is a symlink into the same tree.

What you are tracking is the `release` branch — the repo's default branch — not `main`. Work lands
on `main` continuously; `release` only moves when a tag passes the full gates in CI. So an update
appearing means a release was cut, not that someone pushed.

Two things break this, both silent:

- **Installing with a `#ref`.** pi marks a ref-carrying source as pinned and drops it from the
  update check entirely. You would never be told an update exists. Install with no ref.
- **An install made before the default branch changed.** An existing clone keeps whatever branch it
  originally tracked; flipping the default branch does not rewrite it. Check with
  `git -C "$PKG" rev-parse --abbrev-ref HEAD` — it should say `release`. If it says something else,
  reinstall: `pi remove git:github.com/jserra7d5/bravo-pi-mono && pi install git:github.com/jserra7d5/bravo-pi-mono`.

## Contributor setup

If you are changing the packages rather than just using them, work from a normal clone:

```sh
git clone https://github.com/jserra7d5/bravo-pi-mono.git
cd bravo-pi-mono
git checkout main          # `release` is the default branch; develop on main
npm install                # `prepare` builds the bundle
npm run check && npm run build
npm test --workspaces
```

Point pi at your working copy instead of the published one so you test what you are editing:

```sh
pi remove git:github.com/jserra7d5/bravo-pi-mono
pi install ./path/to/bravo-pi-mono
```

### Cutting a release

```sh
git tag v0.2.0 && git push origin v0.2.0
```

The Release workflow runs the same gates as CI against that commit, rehearses the consumer install
(`npm install --omit=dev`, then asserts the supervisor binary exists), and only then fast-forwards
`release`. A tag that fails the gates never reaches anyone — `release` does not move and installs
stay on the last good commit. `workflow_dispatch` takes a ref if you need to release without tagging.

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
