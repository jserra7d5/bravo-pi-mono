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

## 5. Teach Claude when to delegate

**This step is what makes the rest of it worth installing.** Everything above gives Claude the
*ability* to delegate. Nothing so far gives it the *bias* to. Without this, the skill sits unused and
Claude keeps doing the work itself.

The skill is only loaded once Claude decides to delegate, so the routing rules have to live somewhere
Claude reads unprompted — your global `~/.claude/CLAUDE.md`. Append this:

```markdown
## Picking models for workflows and subagents

Delegate implementation, planning, diagnosis, repository investigation, and code-level
review to a GPT-5.6 Sol lane via the `/pi-async-subagents` skill — provided the task is
verifiable and well-briefed. Prefer its named `scout`/`planner`/`worker`/`reviewer`/
`generalist` templates over a hand-authored raw Pi prompt; use the narrowest that fits.

That proviso is the rule, not a footnote. Sol's usefulness assumes external verification:
it fabricates completions, games vague success criteria (the highest eval-gaming rate METR
has measured), and does not abandon a failing approach on its own. So the question is never
"is this big enough to delegate" — it is "can I state the success criterion precisely
enough that I could check it without trusting the agent?"

- Yes → delegate. Size is irrelevant; a ten-line fix with a named test is a fine lane.
- No → tighten the brief until it is, or keep it inline. Never hand out work that is
  ambiguous, self-graded, or unverifiable. More reasoning does not fix a gameable brief;
  it games it harder. Put a fails-twice guardrail in every implement brief.

Never bank a lane's self-report. `completed` means the process exited, not that the work is
right. Re-run the gates and read the diff yourself. Judge a reviewer lane by its parsed
SEVERITY findings, never by how well the report reads — Sol's prose is polished regardless
of depth. An implausibly short run is a claim to disprove.

Three kinds of work stay in a Claude lane, as routing rather than preference:

- Frontend/UI implementation — Sol's documented weak zone (generic output, element
  over-generation, callout spam). Keep Sol on the backing logic, route the UI to Claude.
- Voice, copy, interaction feel, visual polish — taste is the success criterion, and taste
  is not verifiable by a gate.
- "Was this built the right way?" — Sol hunts bugs and edge cases well, but judging intent
  (in the spirit of the spec, the simplest way it could be done) is a different job. On
  anything that matters, run both a Sol reviewer and a Claude reviewer.

On multi-step builds, act as the lead: own the plan, the briefs, the seam design, and the
integration yourself; delegate the implement and review passes. A child is never another
orchestrator — a brief that says "figure out what to do and then do it" describes your job,
not a lane's.

Escalate a `scout` to `planner`/`generalist` only when the work needs judgment —
classifying, comparing against a baseline, weighing designs, diagnosing — rather than
finding and reporting what is there. A brief spanning dozens of files is normal scout work
and is not a reason to re-route.

Omit `--thinking`; the templates encode sane levels. Raise it only when the bounded task is
genuinely harder than the role's norm, and only after the brief is already tight.
```

Adjust it to your own habits — it is a starting bias, not a contract. Keep two rules, though, because
dropping them is how people end up distrusting the tool: **verifiable-and-briefed** is what keeps Sol
inside its competence, and **never bank the self-report** is what catches it when it strays anyway.

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

Validate locally first — CI does not do it for you:

```sh
npm run check && npm test --workspaces
git tag v0.2.0 && git push origin v0.2.0
```

The Release workflow publishes only: it checks out the tag and fast-forwards `release`. No tests, no
type-check, no build run in CI. Whatever you tag reaches everyone on their next `pi update`, so tag
commits you have actually run. `workflow_dispatch` takes a ref if you need to release without tagging.

If a bad release does go out, the fix is another release — move `release` back by dispatching the
workflow against the last good commit.

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
