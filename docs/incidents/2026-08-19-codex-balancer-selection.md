# Issue ledger — 2026-08-19 codex balancer incident

Findings from the night of 2026-08-19, when `bravo-codex-balanced` began
rejecting leases across the whole agent fleet. Two defects were fixed; the rest
are open and recorded here rather than lost in session scrollback.

Evidence came from the live state root (`~/.bravo/codex-auth-balancer`) and from
six Claude sessions and two Pi sessions reporting raw errors during triage.
Anything marked **unverified** is a second-hand report I did not confirm myself.

## Status summary

| # | Issue | Owner | Severity | Status |
|---|---|---|---|---|
| 1 | In-flight reservations charged against quota | codex-auth-balancer | high | fixed `94c26ff` |
| 2 | Session affinity was a hard pin | codex-auth-balancer | high | fixed `94c26ff` |
| 3 | Redactor replaced every hostname with `[REDACTED_TOKEN]` | codex-auth-balancer | medium | fixed `e3f41b5` |
| 4 | Resident processes hold old policy | operational | medium | mitigated |
| 5 | Weekly conservation penalty never fires | codex-auth-balancer | high | open |
| 6 | Lease reservations carry no run id | codex-auth-balancer | medium | open |
| 7 | Balancer database grows without bound (431 MB) | codex-auth-balancer | medium | open |
| 8 | `POLICY.version` / `DB_SCHEMA_VERSION` naming collision | codex-auth-balancer | low | open |
| 9 | A schema-2 build exists off-tree and is dormant | unknown | high | open |
| 10 | Window labels do not match window durations | codex-auth-balancer | medium | open |
| 11 | No `cwd` validation before spawn | async-subagents | low | open |
| 12 | Expiry salvage never reports committed state | async-subagents | medium | open |
| 13 | `task` CLI documented but absent | async-subagents | medium | open |
| 14 | Remaining quota invisible at dispatch | async-subagents | medium | open |
| 15 | Cross-session `pkill -f` kills sibling builds | operational | medium | open |
| 16 | Content filter flags security-review remediation briefs | operational | medium | open |
| 17 | 30-minute run wall expires broad briefs | async-subagents | low | open |

---

## Fixed

### 1. In-flight reservations were charged against quota

Every pending reservation deducted a flat 5 percentage points
(`reservationHoldPercent`) from a window's remaining percent *before* the
hard-floor check. At 7% remaining, two concurrent requests drove the effective
value to 0, below the floor of 1, and the slot was rejected outright.

```
slot 1 (7% remaining):  active=0 -> 7.0 ok | active=1 -> 2.0 ok | active=2 -> 0 REJECTED
slot 2 (19% remaining): active=3 -> 4.0 ok | active=4 -> 0 REJECTED
```

Four sessions hit this within minutes of each other at 3–4 concurrent children.
It also flattened balancing to round-robin: a 10-point busy penalty plus the
5-point hold outweighed the real 12-point quota gap between accounts.

Concurrency is now charged once, as a small score penalty
(`activeReservationPenalty` 10 → 2). Hard floors gate on real remaining quota.
Genuine exhaustion is caught by the floors and by 429 rotation.

### 2. Session affinity was a hard pin

`startTokenLease` passed the sticky affinity slot as a strict slot request, so a
pinned session failed with `slot unavailable by policy` instead of using the
other account. Affinity and rotation hints are now a soft preference that falls
back to the full account set and records `preferred_slot_unavailable:<slot>` in
the selection penalties. An explicit `--slot` stays hard.

The two defects compounded: #1 manufactured the scarcity, #2 turned it into a
hard failure.

### 3. The redactor replaced every hostname with `[REDACTED_TOKEN]`

`JWT_RE` in `src/oauth-error.ts` was `/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g`
— any three dot-separated alphanumeric runs, which is every hostname, package
name, and stack frame. An upstream error reached an operator as:

```
Please try again with a different prompt: https://[REDACTED_TOKEN]/docs/guides/reasoning
```

Now anchored on the `eyJ` header prefix. Over-redaction only; nothing secret was
ever exposed. Reported by the agent-3 session.

---

## Mitigated, not fixed

### 4. Resident processes hold the old policy

A lease policy change only reaches processes started after the rebuild. Two Pi
sessions (a live task board and a live release board) kept failing after the fix
and could not be restarted without discarding in-flight work.

Old code only fails when *hard-pinned* to a slot that misses the floor, so the
mitigation was to delete the live affinity pins pointing at the drained slot:

```
live pins -> slot 1:  23   (22 deleted at 01:40:42; one expired mid-sweep)
live pins -> slot 2:  41   (untouched)
expired:           10568   (untouched)
backup: ~/.bravo/codex-auth-balancer/leases/affinity-slot1-backup-1787128842
```

Confirmed working: an old-policy process subsequently recorded
`candidates_considered: 2` instead of `1`, and one old-policy lane
(`run_mszttqfb_3I6alPGtidw`) completed successfully afterwards.

This will recur on every future policy change. Worth deciding whether the
balancer should expose a "reload policy" path, or whether policy belongs in the
database rather than in resident memory.

---

## Open — codex-auth-balancer

### 5. The weekly conservation penalty never fires

`weeklyConservationPenalty` is meant to taper burn as a weekly window drains. It
keys off the window named `secondary` and its `resetAt`. On these accounts the
weekly window arrives named `primary` (see #10), and the `secondary` entry has no
`resetAt`, so the branch is dead. Nothing has been throttling burn.

Measured that night: 4.59 points/hour combined against 24 points remaining and a
19.4-hour wait for reset — roughly five hours of runway followed by thirteen
hours of hard stop.

The fix is to select the conservation window by `windowMinutes`, not by name.

### 6. Lease reservations carry no run id

Per-session quota attribution is impossible: the provider lease path never passes
a run id, so the balancer cannot tell whose lanes are spending the shared window.

```
reservations in a 30-minute sample: 583, of which run_id IS NULL: 583
```

`chooseSlot` already accepts `runId`/`rootRunId` and the columns exist. Only the
`startTokenLease` path fails to thread them through. Without this, the only
answer to "who is burning the quota" is fleet-wide averages.

### 7. The balancer database grows without bound

```
balancer.sqlite3   431.5 MB
launch_events      781,882 rows
reservations       337,815 rows
usage_snapshots    106,234 rows
usage_windows      212,460 rows
```

Roughly 13,000 reservations per day at current load, with no pruning or
retention policy. Every lease writes a `reserved` and a `token_lease_finished`
event. Needs a retention window and a vacuum path.

### 8. `POLICY.version` and `DB_SCHEMA_VERSION` collide by name

`DB_SCHEMA_VERSION` is 1; `POLICY.version` was bumped to 2 by `94c26ff`. So
`codex-auth-balancer policy --json` now prints `version: 2` — one day after an
operator saw `unsupported balancer sqlite schema version: 2` during a real brick
(#9). Two unrelated numbers, one word. Rename the policy row to
`selection_policy_version`.

### 9. A schema-2 build exists somewhere off-tree

At 20:07 local on 2026-08-18 a build with `DB_SCHEMA_VERSION = 2` stamped the
shared database, and every resident process on the older build refused it:

```
[codex-balanced-provider] lease finish failed: unsupported balancer sqlite schema version: 2
```

`src/index.ts` fails closed on a database newer than the code, which is correct.
It was repaired five minutes later — `balancer.sqlite3.bak-schemadowngrade-1787109121`
(405 MB) sits in the state root, and the live database is consistent at
`PRAGMA user_version = 1` with `schema_metadata.schema_version = 1`.

That build is not in this repo's tree or dist, so it came from elsewhere and is
dormant. If it runs again it re-bricks every resident process. `src/index.ts`
carries an explicit comment saying the constant must not be bumped for exactly
this reason. Worth finding the build and deleting it.

### 10. Window labels do not match window durations

The window reported as `primary` carries `window_minutes: 10080` — seven days.
The window reported as `secondary` has no `window_minutes`, no `reset_at`, and no
data, and renders as 100%.

```
slot 1  primary  rem  7%  window_minutes 10080  reset_at 08-19 21:06
slot 2  primary  rem 17%  window_minutes 10080  reset_at 08-19 21:06
        secondary rem 100%  window_minutes NULL  reset_at NULL
```

So the figures everyone reads as "5-hour window, weekly reserve untouched" are
the weekly position with no reserve behind it. This misled every session
including mine, and it is what makes #5 silently dead. Anything that reasons
about window semantics must key off `windowMinutes`, and an empty window must
render as unknown rather than 100%.

---

## Open — async-subagents

Not touched during this incident: the package has a large uncommitted refactor in
its working tree (a `--cwd` / `--store-cwd` split plus an installer extraction).

### 11. No `cwd` validation before spawn

`start.ts` resolves `input.cwd ?? process.cwd()` and hands it to the child. When
the directory does not exist, the failure surfaces as `spawn pi ENOENT`, which
points the reader at a broken Pi install rather than a bad path. One session lost
a lane to a typo'd worktree name this way. The pending `--cwd` / `--store-cwd`
split makes the confusion more likely, not less.

### 12. Expiry salvage never reports committed state

A lane that expires after committing real work reports "This run ended before it
emitted a final report" and lists only event bodies. The salvage summary reflects
emitted events, never committed state, so it cannot mention that the lane already
landed a commit. One session dispatched a redundant continuation off such a
summary and had to cancel it. Salvage should read the branch head and dirty state
at expiry.

### 13. The `task` CLI is documented but absent

A skill body loaded in a live session instructs the lead to use
`async-subagents task create|list|get|update|cancel|clear`. Those calls worked
until a rebuild at 01:33, then began printing usage and exiting.

No commit has ever added a `task` subcommand to that CLI
(`git log -S'"task"' -- packages/async-subagents/src/cli.ts` returns nothing),
and neither `HEAD` nor the working tree contains one. The task store's real
surface is Pi *tools* — `task_create`, `task_list`, `task_get`, `task_update`,
`task_cancel`, `task_clear` in `extensions/pi/tools.ts`. `TaskStore` itself is
intact.

So a dist built from an uncommitted local state carried a CLI shim, and a rebuild
removed it. The loaded skill body and the file on disk have diverged. Note also
that `~/.async-subagents/bin/async-subagents` symlinks into that dist, so any
rebuild changes the CLI under every running session at once.

Decide whether the `task` CLI should exist. If yes, land it and keep the skill
honest; if no, correct the skill body.

### 14. Remaining quota is invisible at dispatch

A lead fanning out lanes has no signal that it is spending a scarce shared window
until a child dies. The data already exists: `prepareLaunch` returns
`primary_remaining_percent` and `secondary_remaining_percent`, and
`start.ts` records them as `primaryRemainingPercent` in launch metadata. Nothing
surfaces them to the dispatching agent, and nothing ties them to a death reason.
Requested independently by two sessions.

### 17. The 30-minute run wall expires broad briefs

Five lanes across three sessions hit `MAX_RUN_SECONDS_EXPIRED`
(`effectiveMaxRunMs: 1800000`) in a single day, several after committing real
work. Either the wall is too low for the briefs being written, or briefs need
scoping guidance. Interacts badly with #12.

---

## Open — operational

### 15. Cross-session `pkill -f` kills sibling builds

Two background `make -C data check` runs in one worktree were SIGTERMed (exit
143) while sibling sessions ran gates in other worktrees. `pkill -f` matches the
full command line and does not care which worktree it came from, so one session's
cleanup kills every session's matching build. The affected session worked around
it with `setsid make --directory data check`, which only dodges the pattern.

Cleanup patterns need to be scoped to the session's own process group.

### 16. Content filter flags security-review remediation briefs

Three lanes lost to upstream moderation across two sessions, all on the same
mechanism: **text describing a security defect reads to a moderation classifier
like an attempt to cause one.**

- A `--type answer` message carrying a code-review severity rubric —
  "security-relevant", "forbidden", "refuses", "attack" — injected mid-run
  without the surrounding code context that would frame it as review guidance.
- Two flags in one continuation lineage, since a continuation carries its
  accumulated transcript into the moderation check.
- `run_mt027mim_9Bfjk2gsbjo`, a remediation lane pointed at a review brief
  containing "always refuses", "silently drops its filter", "sanitization
  leaked".

This is not incidental. The adversarial-review → remediation loop is a standard
workflow here, and a remediation brief is *by construction* a list of security
defects written in the vocabulary that trips the classifier. Expect it to recur
on any lane whose brief is review output, and note that severity scales with how
security-focused the review was — the better the review, the likelier the
remediation lane is refused.

Practical mitigations, in order of how well they have held up:

1. Do not continue a lineage that has been flagged. Start a fresh lane with a
   summarized brief; a continuation re-submits the whole flagged transcript.
2. Put rubrics in the initial brief, where task context frames them, rather than
   injecting them as a bare mid-run message.
3. In remediation briefs, describe findings by location and required outcome
   rather than by quoting the attack narrative — "input filter drops a case at
   handler.ts:88; make it total" rather than "sanitization leaked".

Worth considering whether remediation lanes should route to a provider without
this classifier rather than being reworded around it.

---

## Reported but unverified

- `api.quantiiv.dev` and `api.quantiiv.com` are reported to share one database,
  with identical rows down to millisecond `updated_at`. If true, any lane writing
  to the dev host expecting isolation is writing to production. Recorded here
  because the consequence is severe; verify before relying on it either way.
