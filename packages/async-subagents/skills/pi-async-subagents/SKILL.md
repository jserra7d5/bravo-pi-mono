---
name: pi-async-subagents
description: Launch and orchestrate named, role-scoped GPT/Pi agents through the durable async-subagents runtime. Use when Claude should delegate repository investigation, planning/spec authoring, bounded implementation, merge-risk review, or broad mixed-mode work to the existing scout, planner, worker, reviewer, or generalist templates; when parallel independent lanes help; or when a prior child should be resumed/continued with its recorded Pi session. Prefer this over raw headless Pi for work matching a named role.
---

# Pi Async Subagents

Delegate to named role templates through the `async-subagents` CLI (run from the target repo or pass
`--cwd`). All commands emit JSON; `watch` emits NDJSON. Flag reference: `--help`.

```bash
async-subagents --help
```

If `async-subagents` is not on PATH, the install step was skipped — see the package README
(`packages/async-subagents/README.md`) for `async-subagents install`.

**Roles — pick the narrowest.** `scout` retrieval/source summaries (pinned to Luna deliberately: retrieval is not a judgment task, so a large read surface is never a reason to escalate); `planner` designs/specs/sequencing; `worker` bounded implementation; `reviewer` merge-risk review against an accepted contract; `generalist` only when nothing narrower fits. A child is never another orchestrator. `async-subagents agents --cwd "$PWD"` lists the live catalog.

## Brief and write scope

Substantial task → brief file (`--task-file`) with: objective + completion bar, write scope, source-of-truth paths, deliverable, exact validation commands, stop conditions and non-goals.

`--file` is the child's authoritative write-scope contract (prompt enforcement, not an OS sandbox): exact paths, directory roots, or globs (`*` in-segment, `**` across). Scope by the ownership boundary the task owns — a package root plus its tests — and `--protect` the must-not-touch files inside it (specs, ledgers). Never pass read-only references as `--file`: the child reads anything in `--cwd`; `--file` only licenses writing.

A child needing an out-of-scope path doesn't die — it emits a `blocked` attention line and keeps its context. Grant additively with `message --run-id X --task "..." --file path` (child resumes in seconds; narrowing mid-run is impossible), then **re-arm `watch` on that run** — the attention line ended the previous watch. A lane started without `--file` takes the grant too — it lands as an additive amendment on top of the scope its brief states, and `allowedFiles` stays unset rather than silently narrowing the lane to the one path you granted.

## Start, watch, collect

`start` is async and returns immediately. **Capture `runId` from its JSON — never `tail` that output.** `runId` sits near the TOP (~line 5 of ~44, under `summary`), so `tail -n` silently drops it:

```bash
S=$(mktemp)
async-subagents start --cwd "$PWD" --agent worker --task-file brief.md --file 'src/**' > "$S" 2>/dev/null
RID=$(grep -oE '"runId": *"[^"]+"' "$S" | head -1 | grep -oE 'run_[A-Za-z0-9_-]+')
```

Redirect stderr with `2>/dev/null`, **not `2>&1`**: node prepends an `ExperimentalWarning: SQLite` banner to the stream, and `jq` then dies with `parse error: Invalid numeric literal` (observed). Same applies to every subcommand you parse.

**A lost runId is not cosmetic — it manufactures a duplicate write-lane.** The run is already alive and writing; a parent that can't see its runId reads the start as failed and re-dispatches, landing two lanes in one checkout — the corruption invariant below, reached from the other direction. Observed: two workers, 18 write calls each, same 17 files, tree unrecoverable and discarded.

**Recover a lost runId** — `status` with no `--run-id` lists this project's runs, newest first, each with its live state read from `status.json`:

```bash
async-subagents status --cwd "$PWD" --limit 10 2>/dev/null
```

Add `--all` to sweep every project (each cwd hashes to its own project directory, so a lane started in another worktree is invisible without it). Then `status --run-id` every candidate and `cancel` any `running` lane you did not intend — do this BEFORE re-dispatching, not after. Don't go hunting in `~/.async-subagents/runs/`: that tree exists but holds unrelated tooling runs (`cwd: /tmp/async-subagents-tools-*`) and will convince you your lane never started. Real runs live under `~/.async-subagents/projects/<hash>/runs/` — the listing gives the exact path as `runDir`.

Pass one `--root-session-id` across sibling lanes. There is no push channel under a CLI parent (start returns `delivery.mode:"none"`) — the completion signal is `watch`, wrapped in ONE Monitor covering every lane:

```bash
async-subagents watch --cwd "$PWD" --run-id RUN_A --run-id RUN_B
```

One NDJSON line per lifecycle transition; exits when all runs are terminal-or-attention. Act on `bucket`:

- `terminal` (`completed|failed|cancelled|expired`) — done. The line inlines `resultSummary` and the full `resultBody` once per run (a rewatch gets `resultReported:true` + `resultPath`); a separate `result` call is rarely needed.
- `attention` (`paused|blocked|waiting_for_input`, machine-readable `attentionReason`) — the lane needs you: answer, grant scope, or `continue`/`cancel`. Attention is not done and won't resolve itself.
- `busy` — keep waiting; `staleForMs` is time since the run's last status write.

`watch` reconciles before reporting (dead supervisor → `failed`/`SUPERVISOR_DIED`; never-claimed start → `SUPERVISOR_LAUNCH_FAILED`; torn finalization repaired), so silence means "still running." New lane mid-session → arm another Monitor+`watch`; watchers are cheap. Budget expiry is terminal `expired` with partial output as the result — `continue` resumes it from the recorded session.

**Hard-won invariants:**

- `wait`, `run`, and `continue --timeout-seconds` block; a foreground Bash timeout kills the **entire descendant tree**, detached supervisors included (observed: run finalized `cancelled/SUPERVISOR_SIGNAL`). Blocking calls only in a background Bash; prefer `start`/plain `continue` (returns immediately) + `watch`.
- Never two write-lanes in the same checkout: concurrent lanes' commits sweep each other's in-progress files even with disjoint `--file` scopes. Separate worktrees, or sequence. The usual way this happens is not a deliberate fan-out but a re-dispatch after losing a runId (above) — so before any `start`, confirm no lane is already live for this `projectRoot`. If two did overlap, the tree is contaminated: both agents wrote the same files with independent designs, and the result can still import and still be wrong. Grep the orphan's `pi-session/session.jsonl` for `"name":"write"` to size the damage, then discard the generated tree and re-run ONE lane — do not try to reconcile it by reading.
- Verify the work, not the state: `completed` means the lane exited, not that it's correct. Re-run the gates and read the diff yourself. An implausibly short run is a claim to disprove — read its result before banking it.

## Sol behavioral profile — why the verify rules exist

Most lanes run GPT-5.6 Sol. These are documented failure modes from published evaluations (OpenAI's
system card, METR, Artificial Analysis); shape briefs and judge output accordingly.

- **Never accept Sol's self-reported completion.** Sol fabricates completions at a higher rate than 5.5 — OpenAI's own system card documents it claiming unperformed work was done. Demand pasted validation output in the deliverable; re-verify claimed file/test state yourself before accepting a lane result.
- **Tighten the criterion before raising thinking.** METR measured Sol's eval-gaming rate as the highest of any public model — a vague success bar gets satisfied by the letter, not the intent, and more reasoning only games it harder at 2–3x the cost. Add an explicit success criterion, dependency/tool-routing rule, or verification loop first; escalate `--thinking` only when the brief is already tight.
- **Expect grinding, not course correction.** Sol commits to one reasoning path and almost never abandons a failing approach on its own. Put a fails-twice guardrail in every implement brief ("if the same gate fails twice, stop and report rather than iterating"); treat your external review loop as Sol's course correction, because it has none of its own.
- **Don't route frontend/UI implementation to Sol by default.** Known weak zone — generic output, element over-generation, callout spam; Sol-authored code also trends toward excessive tests and overcomplicated APIs. Keep Sol on backing logic and route UI implementation to a Claude lane; when reviewing Sol-authored code, check for the test-excess and API-overcomplication tics specifically.
- **Polish is not depth.** Sol's output presents extremely well regardless of substance (highest Presentation Elo on AA-Briefcase, weak rubric score) — fluent prose is not evidence the work was deep. Judge reviewer lanes by their machine-parsable `SEVERITY` findings and evidence, never by how good the report reads.

## Levers

- `--thinking`: omit — templates encode sane defaults. Raise only when the bounded task is genuinely harder than the role's norm; tighten a gameable brief before adding reasoning.
- `--fast-track` (`start`/`run`): priority service tier, faster output at higher cost. Only under user authorization — explicit ("fast-track this") or implicit urgency ("this is blocking me") — and scoped to the current effort. Spend it on the lane whose latency gates the plan: implementation, gating review, or a bottleneck scout read. Codex-model children only (others launch normally with `fastTrack.applied:false`); confirm `applied:true` in the start response.

## Continue vs fresh

`continue` (same recorded session, same role) for clarification, remediation by the same worker, closure review by the original reviewer, or resuming `expired`. Start fresh on role change, premise contamination, materially changed contract, or an independent release audit. Review lifecycle: fresh initial → continued closure → one fresh release audit; `NEEDS_DECISION` is a lead decision gate, not a failure.

## Housekeeping

Terminal runs untouched for 7 days auto-archive (opportunistic capped sweep on `start`; disable with `ASYNC_SUBAGENTS_NO_AUTO_ARCHIVE=1`) to `~/.async-subagents/archive/YYYY-MM/<runId>.tar.zst`, indexed in `archive/archive-index.jsonl`, and leave the live tree. Archived runs can't be continued in place — extract the tarball if an old transcript matters. Manual: `async-subagents archive [--older-than-days N] [--cap N] [--dry-run]` (global, no `--cwd`).

Raw Pi (`pi-agent-usage`) is a low-level escape hatch only: no named role fits, an ephemeral no-session analysis is explicitly wanted, or debugging Pi/provider flags.
