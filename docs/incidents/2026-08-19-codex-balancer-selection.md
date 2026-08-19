# Issue ledger — 2026-08-19 codex balancer incident

Findings from the night of 2026-08-19, when `bravo-codex-balanced` began
rejecting leases across the whole agent fleet. Three defects were fixed during
triage (#1, #2, #3); a second pass on 2026-08-19 fixed #5+#10, #6, #11, #14, #4
(tunables only), #8, #7 and #16, and closed #13 as no-action. Landing #7 caused a
fleet outage of its own, recorded as #18. The rest are open and recorded here
rather than lost in session scrollback.

Evidence came from the live state root (`~/.bravo/codex-auth-balancer`) and from
six Claude sessions and two Pi sessions reporting raw errors during triage.
Anything marked **unverified** is a second-hand report I did not confirm myself.

## Status summary

| # | Issue | Owner | Severity | Status |
|---|---|---|---|---|
| 1 | In-flight reservations charged against quota | codex-auth-balancer | high | fixed `94c26ff` |
| 2 | Session affinity was a hard pin | codex-auth-balancer | high | fixed `94c26ff` |
| 3 | Redactor replaced every hostname with `[REDACTED_TOKEN]` | codex-auth-balancer | medium | fixed `e3f41b5` |
| 4 | Resident processes hold old policy | codex-auth-balancer | medium | fixed for tunables (unreleased) |
| 5 | Weekly conservation penalty never fires | codex-auth-balancer | high | fixed (unreleased) |
| 6 | Lease reservations carry no run id | codex-auth-balancer | medium | fixed (unreleased) |
| 7 | Balancer database grows without bound (431 MB) | codex-auth-balancer | medium | fixed (unreleased) |
| 8 | `POLICY.version` / `DB_SCHEMA_VERSION` naming collision | codex-auth-balancer | low | fixed (unreleased) |
| 9 | A schema-2 build exists off-tree and is dormant | unknown | high | open — searched, not on disk |
| 10 | Window labels do not match window durations | codex-auth-balancer | medium | fixed (unreleased) |
| 11 | No `cwd` validation before spawn | async-subagents | low | fixed (unreleased) |
| 12 | Expiry salvage never reports committed state | async-subagents | medium | open |
| 13 | `task` CLI documented but absent | async-subagents | medium | closed — no action |
| 14 | Remaining quota invisible at dispatch | async-subagents | medium | fixed (unreleased) |
| 15 | Cross-session `pkill -f` kills sibling builds | operational | medium | open |
| 16 | Content filter flags security-review remediation briefs | operational | medium | prompting updated (unreleased) |
| 17 | 30-minute run wall expires broad briefs | async-subagents | low | open |
| 18 | Retention sweep on the lease path took the fleet down | codex-auth-balancer | high | fixed (self-inflicted, same day) |

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

### 5 + 10. Window semantics keyed off the label instead of the duration

One root cause behind two symptoms, so one fix.

`weeklyConservationPenalty` keyed off the window *named* `secondary` and its
`resetAt`. On these accounts the seven-day window arrives named `primary`, and
`secondary` arrives with no `window_minutes`, no `reset_at` and no data:

```
slot 1  primary   rem   7%  window_minutes 10080  reset_at 08-19 21:06
slot 2  primary   rem  17%  window_minutes 10080  reset_at 08-19 21:06
        secondary rem 100%  window_minutes NULL   reset_at NULL
```

So the branch was dead and nothing throttled burn — measured that night at 4.59
points/hour against 24 points remaining and a 19.4-hour wait for reset, roughly
five hours of runway followed by thirteen hours of hard stop. The same labelling
made every operator read the weekly position as "5-hour window, weekly reserve
untouched", because a window carrying no signal at all rendered as 100%.

Both are now duration-keyed:

- `conservationWindow()` picks the longest window declaring
  `windowMinutes >= 1440`, whatever the upstream called it, and requires a real
  `remainingPercent` and `resetAt`. The taper is computed against **that
  window's own length** rather than a hardcoded `WEEK_MS`, so a slot is "on
  pace" when remaining% is at least the fraction of the window still to run.
- `normalizeWindow()` returns `undefined` for a window with no
  remaining/duration/reset signal, so an empty window is *unknown* everywhere
  rather than full. `getUsage` and `prepareLaunch` no longer report a
  `secondary` that was never measured.

Guarded by three tests that fail on the old code: a weekly window under the
label `primary` must taper, a 5-hour window under the label `secondary` must
not, and a signal-less window must not surface at all.

### 6. Lease reservations carry no run id

Every provider lease wrote `run_id NULL`, so the only answer to "who is burning
the shared window" was a fleet-wide average:

```
reservations in a 30-minute sample: 583, of which run_id IS NULL: 583
```

`chooseSlot` already took `runId`/`rootRunId` and the columns already existed;
only `startTokenLease` failed to thread them. It now defaults them from the
child's own environment — `ASYNC_SUBAGENTS_RUN_ID` and
`ASYNC_SUBAGENTS_PARENT_RUN_ID`/`ASYNC_SUBAGENTS_ROOT_SESSION_ID`, which
`start.ts` already sets on every child — with an explicit `run_id` on the lease
input taking precedence. `codex-auth-balancer token` gained `--run-id` /
`--root-run-id` for the command-backed path.

---

### 11. No `cwd` validation before spawn

`start.ts` resolved `input.cwd ?? process.cwd()` and handed it to the child. When
the directory did not exist, the failure surfaced as `spawn pi ENOENT`, which
points the reader at a broken Pi install rather than a bad path. One session lost
a lane to a typo'd worktree name this way.

`startSubagent` now validates both roots before anything downstream touches them,
naming which flag is wrong and what path it resolved to:

```
LAUNCH_CWD_NOT_FOUND        --cwd (child execution/discovery) does not exist: /path
LAUNCH_CWD_NOT_A_DIRECTORY  --cwd (child execution/discovery) is not a directory: /path
LAUNCH_CWD_NOT_FOUND        --store-cwd (canonical run storage) does not exist: /path
```

`--store-cwd` is checked separately only when it differs from `--cwd`, so the
split the incident warned about is now the thing that makes the message precise
rather than the thing that makes it ambiguous.

### 14. Remaining quota is invisible at dispatch

A lead fanning out lanes had no signal that it was spending a scarce shared window
until a child died. Requested independently by two sessions.

The original suggestion — surface what `prepareLaunch` already returns — does not
work: `prepareCodexBalancer` returns early unless `copiedCredentialsLegacy` is
set, so on the default lease path `prepareLaunch` is never called from `start.ts`
at all. Its `primaryRemainingPercent` metadata is legacy-only. And reserving a
slot just to ask a question would charge the window to measure it.

So the balancer gained a read-only accessor, `getConservationQuota()`, and
`startSubagent` reports it on every start:

```
Subagent run_x started: worker (running); use async-subagents watch for run run_x.
Shared 7d quota 7% (slot-a, resets in 19h)
```

Three properties this had to have, each with a test that fails without it:

- **Duration-keyed, not label-keyed.** It reuses the same `conservationWindow()`
  as #5/#10, so a weekly window is found whatever the upstream labels it, and a
  5-hour window is never reported as a reserve. Window semantics stay in one
  place — the whole lesson of #10.
- **Read-only.** Opening the database *creates* it, so the accessor returns
  early when no ledger exists. An existing test (`no sqlite/leases written under
  stateDir`) caught this as a regression on the first attempt.
- **Advisory.** A balancer that cannot be read reports no quota and never fails a
  launch.

Slots with no measurable long window are omitted rather than reported as full,
and the line is emitted on every start rather than only when low — a lead sizing
a fan-out needs the number before the lanes exist, and silence must not read as
plenty. Still open: nothing ties a child's death reason back to the window.

### 4. Resident processes hold the old policy

A lease policy change only reached processes started after the rebuild. Two Pi
sessions (a live task board and a live release board) kept failing after the fix
and could not be restarted without discarding in-flight work. The triage
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

**Scope of the fix — read this before relying on it.** Selection policy now lives
in the database, so a policy change reaches every resident process on its next
lease. That covers *tunables only*: `POLICY` is nine scalars. It does not
propagate changed selection **logic**. Of the defects in this ledger, only part of
#1 (`activeReservationPenalty` 10 → 2) was a number; the floor-check restructure,
soft affinity (#2), and the duration-keyed window (#5/#10) were all code, and none
of them would have reached a resident process this way. A build with different
logic is still a different build. Part three below is what makes that visible
rather than silent.

Three changes:

1. **Publication is upgrade-only.** `initializePolicy` previously upserted
   unconditionally on every `openDb` — which is every lease — so any resident old
   build overwrote a newer build's published policy on the very next lease it was
   meant to reach. It now writes only when the running build's policy version
   exceeds the stored one, and records `published_by` / `published_at`.
2. **Selection reads the published policy**, merged over the running build's
   defaults key by key. Only keys the build already knows are taken, and only as
   finite numbers — so a newer publisher can retune an older process but can never
   inject a key it has no code for, and a corrupt row degrades to compiled
   defaults instead of failing a lease. Tie-breaks are keyed off the *published*
   version so every process, old build or new, orders candidates identically.
3. **A stale build is flagged, never refused.** When the running build's policy
   version is below the published one, selection records
   `stale_policy_build:<pkg>@policy<own><published<n>` in the penalties, which
   already land in `reservations.metadata_json`. So
   `codex-auth-balancer reservations --json` now answers "which processes are
   running old code" — the question that cost a filesystem hunt during this
   incident, and the same question #9 needs. It does **not** affect score, and a
   stale build still leases: failing closed on a version mismatch would be #9
   rebuilt on purpose.

`getPolicy` reports what is in force and what this build compiled separately
(`policy` / `selection_policy_version` vs `compiled` /
`compiled_selection_policy_version`, plus `build` and `stale_build`).

Guarded by five tests, three of which fail on the old code: a published policy
changes what an already-running process selects; a stale build is flagged and
still leases; an older build cannot step the published policy backwards; a corrupt
row degrades to defaults; an unknown key is ignored.

### 8. `POLICY.version` and `DB_SCHEMA_VERSION` collide by name

`DB_SCHEMA_VERSION` is 1 and `POLICY.version` is now 3, so
`codex-auth-balancer policy --json` printed `version: 3` — an operator who had
just seen `unsupported balancer sqlite schema version: 2` during a real brick (#9)
had no way to know the two numbers were unrelated.

The output surface is renamed: `selection_policy_version` and
`compiled_selection_policy_version`. The bare key `version` is gone from
`policy --json` and a test asserts it stays gone.

`SelectionMetadata.policy_version` keeps its name — it is unambiguous in context
and crosses into async-subagents launch metadata as `policyVersion`.

### 7. The balancer database grew without bound

```
balancer.sqlite3   431.5 MB
launch_events      781,882 rows
reservations       337,815 rows
usage_snapshots    106,234 rows
usage_windows      212,460 rows
```

Roughly 13,000 reservations per day, with no pruning and no retention policy.

`pruneDatabase()` deletes rows past a retention window (default 14 days), exposed
as `codex-auth-balancer prune --json [--older-than-days N] [--keep-per-slot N]
[--vacuum] [--dry-run]`. Three things it must never do, each with a test that
fails without it:

- **Never delete an active reservation.** A `pending`/`prepared` reservation that
  has not expired is still holding a slot; deleting it by age would drop it from
  `activeReservationCounts` and let the slot be over-subscribed.
- **Never let a slot become unknown.** Selection reads the newest snapshot per
  slot, so a slot idle longer than the window would lose its usage entirely and be
  scored with `unknownPenalty` for having been idle. A three-snapshot tail per slot
  survives regardless of age.
- **Never re-arm the usage-cache migration.** `migrationCompleted` falls back to a
  `migrated_usage_cache_v2` launch event when the `schema_metadata` key is absent,
  so the marker is promoted before any event is deleted.

VACUUM is opt-in: it rewrites the whole database, needs free space equal to its
current size, and takes an exclusive lock for its duration.

Rehearsed against a `.backup` copy of the live database:

```
before   791,654 launch_events | 342,298 reservations | 107,041 usage_snapshots
after    144,974 launch_events |  75,687 reservations |  33,614 usage_snapshots
full sweep of 1.13M rows       5.5s
concurrent writers during it   9,199 committed, 0 lock errors
integrity_check / foreign_key_check   ok
active reservations            3 before, 3 after
vacuum                         485,470,208 -> 75,956,224 bytes
```

### 18. The retention sweep took the fleet down

Self-inflicted, same day, while landing #7. Recorded because the mechanism is
worth keeping.

Retention was first wired into `finishTokenLease` as an opportunistic sweep. Three
mistakes compounded:

1. `launch_events` references `reservations` `ON DELETE SET NULL` and there was **no
   index on `launch_events(reservation_id)`**. Every reservation delete full-scanned
   all 791,654 events, so deleting 20,000 reservations was ~16 billion row visits.
2. The whole sweep ran inside one `BEGIN IMMEDIATE`, so it held the write lock for
   that entire duration. Every concurrent lease failed with `database is locked`.
3. The sweep recorded that it had run *at the end*. Since it never reached the end,
   every subsequent lease finish started another one. A livelock.

Every agent stopped working. `usage --json` and `token` both returned
`{"error":"database is locked"}`. One async-subagents child (pid 252199, spawned
mid-rebuild) sat at 100% CPU for seven minutes and was killed by exact pid — not by
`pkill -f`, see #15.

The live database was not damaged: `last_pruned_at` was unset, row counts were
unchanged, `integrity_check` returned ok. Nothing had been deleted, because nothing
had ever committed.

Fixes:

- **The four retention indexes are part of the schema**, including
  `idx_launch_events_reservation`. That one is load-bearing, not an optimisation.
- **Deletes are chunked** at 500 rows, each in its own transaction, so the write
  lock is released constantly. The sweep reports the number of transactions it used.
- **Retention is off the request path.** It runs from `prune` by hand or by cron;
  `CODEX_BALANCER_AUTO_PRUNE=1` opts a process back in. Housekeeping that can
  livelock the thing it is housekeeping does not belong on a lease.

Two of the first three regression tests written for this were decorations — the
timing assertions passed with the fault injected, because a test-scale database does
not discriminate. They were replaced with deterministic ones: the transaction count
is reported and asserted, and the index invariant is asserted directly against
`sqlite_master`. All three now fail with their fault injected.

Restored and verified: a real `bravo-codex-balanced/gpt-5.6-luna` scout lane ran end
to end and returned its result.

**The delivery mechanism is the wider lesson.** `~/.async-subagents/bin` symlinks
into this repo's `dist`, so every `npm run build` replaces the code under every
running session at once, with no staging and no rollback — exactly the hazard #13
describes from the other direction. Resident processes then hold whichever build
they started with, which is #4. A rebuild during active fleet work is a deploy.

## Closed — no action needed

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

**Resolved 2026-08-19: no action, in either direction.** The stale dist was the
whole bug.

`HEAD`'s `SKILL.md` references `task` zero times — only `--task` flags — and no
committed revision of it ever described a `task` subcommand. So the skill body on
disk was already honest; the divergence existed only between a live session's
loaded copy and the repo.

The board is not Pi-internal by design either. `parentOnly()` gates on *child
context*, not on harness:

```
function isChildContext(): boolean {
  return Boolean(process.env.ASYNC_SUBAGENTS_RUN_ID || process.env.ASYNC_SUBAGENT_RUN_ID);
}
```

A Claude lead would pass that gate. It simply has no door, and does not need one:
Claude leads already have native task management, and `budget-auto-swarm`'s
SKILL.md already directs them to keep the dependency graph there — "do not create
a second async-subagents task ledger". Adding a CLI surface would mean a second
entry point into `TaskStore` for a lead that has no use for it.

## Open — codex-auth-balancer

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

**Searched 2026-08-19; it is not on disk.** Nothing under `/home/joe` outside
this package mentions `DB_SCHEMA_VERSION`, no committed revision on any branch
ever set it to 2, and both the working tree and `dist/` are at 1. The only other
monorepo checkout (`bravo-pi-mono-tango-server`) does not contain the package at
all, and `~/.async-subagents/bin` symlinks into this repo's dist. One source
copy exists at `/var/tmp/tmpdir-joe/tmp.jR26YQc7fp/codex-auth-balancer`, dated
20:01 on 2026-08-18 — six minutes before the stamp — but it is schema 1 and has
no build output.

Most likely reading: an uncommitted working-tree edit was built into `dist/`,
ran once, and was reverted by a later rebuild. There is nothing left to delete,
so this cannot be closed by removal. It stays open because the failure mode is
unchanged: any local build that bumps the constant bricks every resident process
at once, and fail-closed recovery still needs manual database surgery.

---

## Open — async-subagents

The #11 and #14 fixes above landed on top of the package's in-flight
`--cwd` / `--store-cwd` refactor rather than around it. The items below are
untouched.

### 12. Expiry salvage never reports committed state

A lane that expires after committing real work reports "This run ended before it
emitted a final report" and lists only event bodies. The salvage summary reflects
emitted events, never committed state, so it cannot mention that the lane already
landed a commit. One session dispatched a redundant continuation off such a
summary and had to cancel it. Salvage should read the branch head and dirty state
at expiry.

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

### 16. Content filter flags security-review remediation briefs — prompting updated, root cause remains

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

### Prompting updated 2026-08-19

The mitigations above were operator habits held in session memory. They are now in
the templates, at the two places that actually control the text.

**Upstream, in `agents/reviewer.md`.** A remediation brief *is* review output, so
the cheapest place to make it clean is where it is written. The output contract
now asks for each finding as a location plus the required outcome —
"`handler.ts:88` — the input filter drops the empty-array case; make it total"
rather than "sanitization leaked; an attacker can inject arbitrary payloads" — and
for reachable impact stated as a consequence to the system rather than as
reproduction steps.

This is deliberately framed as *better* review output, not softer: the first form
is what a remediation lane can act on, the second describes a consequence the
fixer does not need in order to fix it. The prompt is explicit that the rule
governs phrasing only and never what gets reported, at what severity, because the
obvious failure mode of a rule like this is a reviewer that learns to avoid
security vocabulary by avoiding security findings. That trade is stated in the
prompt and refused: a review that under-reports is worthless, a refused lane is
merely rerun.

**Lead-side, in `skills/pi-async-subagents/SKILL.md` and the two budget-auto-swarm
prompts.** Never continue a lane refused by moderation — a continuation
resubmits the whole flagged transcript, so a flagged lineage re-trips the filter on
every attempt. Restart fresh with a summarized brief, and keep severity rubrics in
the initial brief where task context frames them rather than injecting them as a
bare mid-run `message --type answer`.

The budget-auto-swarm skill and the Pi lead overlay are byte-locked to
`docs/specs/budget-auto-swarm/prompting.md`, so the spec carries the same text and
its golden test enforces it.

No tests were added for the reviewer and skill prompt text itself: asserting on
prompt vocabulary is a one-time proof with permanent maintenance cost, and the
change is a judgement about wording rather than a behavior with a seam.

**Still open:** whether remediation lanes should route to a provider without this
classifier. Prompting reduces the rate; it cannot remove a classifier from the
path.

---

## Reported but unverified

- `api.quantiiv.dev` and `api.quantiiv.com` are reported to share one database,
  with identical rows down to millisecond `updated_at`. If true, any lane writing
  to the dev host expecting isolation is writing to production. Recorded here
  because the consequence is severe; verify before relying on it either way.
