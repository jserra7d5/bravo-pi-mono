# Tango agents report done but persist only one-line placeholder results

Date: 2026-04-27

## Summary

During a Quantiiv/ROGER Docker debugging session, multiple delegated Tango `generalist` agents completed with `done` status after doing substantial read-only research, but the retrievable result contained only a one-line placeholder such as:

```text
Read-only investigation complete; deliverable provided in final response.
```

or:

```text
Completed retrospective; final answer contains root causes and recommended changes.
```

The parent/root session could not retrieve the actual final response, findings, or report via `tango_result`, `tango_look`, or files in the run directory. This appears to be the same class as the existing feedback files in this directory, but it is still happening and affected multiple new agents in the current session.

Related existing reports:

- `feedback/tango-agent-result-loss-feedback-2026-04-27.md`
- `feedback/tango-empty-done-agent-output-feedback-2026-04-27.md`

## Newly observed cases

### 1. `roger-docker-dev-friction-retro`

Role: `generalist`

Run ID: `run_1777277910662_hru09g`

Task summary:

- Do a holistic retrospective on why local ROGER Docker testing has been painful/diverged from normal ROGER dev.
- Consider config layering, local/cloud Quantiiv API, QAS/Lib/Playbooks version skew, Docker image rebuild requirements, memory/playbook cache, auth/session token minting, skill gating, run viewer/live traces, and test harness gaps.
- Deliver a concise but deep report with root causes, architectural smells, and concrete prevention changes.
- No implementation or commits.

Tango metadata/status said:

```text
Completed ROGER Docker testing retrospective
```

`tango_result` returned:

```text
Completed retrospective; final answer contains root causes and recommended changes.
```

`resultAssessment` warned:

```text
Result deliverable is suspiciously short for a report/audit/planning task.
```

`tango_look` returned only the same one-line output.

Run directory inspection found no durable report artifact:

```text
/home/joe/.tango/runs/Quantiiv-ad3d7747/roger-docker-dev-friction-retro/command.json
/home/joe/.tango/runs/Quantiiv-ad3d7747/roger-docker-dev-friction-retro/metadata.json
/home/joe/.tango/runs/Quantiiv-ad3d7747/roger-docker-dev-friction-retro/metrics.json
/home/joe/.tango/runs/Quantiiv-ad3d7747/roger-docker-dev-friction-retro/result.md   # 84 bytes only
/home/joe/.tango/runs/Quantiiv-ad3d7747/roger-docker-dev-friction-retro/system.md
/home/joe/.tango/runs/Quantiiv-ad3d7747/roger-docker-dev-friction-retro/task.md
```

The actual retrospective was not retrievable.

### 2. `roger-test-safety-generalist`

Role: `generalist`

Run ID: `run_1777278101501_of4pu4`

Task summary:

- Read `ROGER/.claude/skills/roger-mock-dev-email-path/SKILL.md`.
- Investigate what tests/smoke paths should be run before/after Docker/live-viewer/QAS/playbook/Switchyard changes.
- Deliver a practical test matrix:
  1. fastest preflight commands,
  2. targeted integration tests/smokes,
  3. missing tests to add,
  4. likely gaps that allowed current failures,
  5. exact commands and prerequisites.
- Read-only, no edits.

Tango metadata/status said:

```text
Completed read-only ROGER smoke/test matrix investigation
```

`tango_result` returned only:

```text
Read-only investigation complete; deliverable provided in final response.
```

`resultAssessment` warned:

```text
Result deliverable is suspiciously short for a report/audit/planning task.
```

`tango_look` returned only the same one-line output.

Run directory inspection found no durable report artifact:

```text
/home/joe/.tango/runs/Quantiiv-ad3d7747/roger-test-safety-generalist/command.json
/home/joe/.tango/runs/Quantiiv-ad3d7747/roger-test-safety-generalist/metadata.json
/home/joe/.tango/runs/Quantiiv-ad3d7747/roger-test-safety-generalist/metrics.json
/home/joe/.tango/runs/Quantiiv-ad3d7747/roger-test-safety-generalist/result.md   # 74 bytes only
/home/joe/.tango/runs/Quantiiv-ad3d7747/roger-test-safety-generalist/system.md
/home/joe/.tango/runs/Quantiiv-ad3d7747/roger-test-safety-generalist/task.md
```

The actual smoke/test matrix was not retrievable.

### 3. `roger-analyst-tool-errors-generalist`

Role: `generalist`

Run ID: `run_1777278165617_etgt8e`

Task summary:

- Investigate analyst tool failures in local Docker ROGER run `01KQ709V1RS0SSVTDKM3BKS7MQ` / workspace `01KQ709W07X9191K8N3TRQ6JYQ`.
- Inspect run artifacts/logs/trace JSONL and relevant Switchyard/ROGER tool wiring.
- Identify each analyst tool failure before terminal `sqlite3.DatabaseError`, especially `python_execute` failures like `Error building definitions serializer: KeyError: 'ref'`.
- Distinguish real tool-runtime problems from trace-store/payload-recording artifacts.
- Deliver a timeline, root-cause candidates, smallest fix/validation path, and rerun recommendation.
- No source changes.

Tango metadata/status said:

```text
Completed read-only analyst tool error investigation
```

`tango_result` returned only:

```text
Read-only investigation complete; see final response for timeline, evidence, root-cause candidates, and rerun recommendation.
```

`resultAssessment` warned:

```text
Result deliverable is suspiciously short for a report/audit/planning task.
```

`tango_look` returned only the same one-line output.

No detailed timeline, evidence, root-cause candidates, or rerun recommendation were retrievable through Tango.

This one is particularly damaging because it investigated a currently active catastrophic failure. The parent now has to either duplicate the log/trace analysis manually or rerun the agent with an explicit durable report path.

## Why this matters

This occurred while the user was already distressed by repeated ROGER Docker breakages. The exact purpose of delegating these agents was to step back, reduce chaos, and produce stable findings/test guidance. Instead, the agents appeared to complete successfully but lost the actual deliverables.

Operational impact:

- Parent/root session cannot synthesize child findings.
- User trust in delegation is damaged.
- Root agent must either duplicate work or rerun agents.
- Time and tokens are wasted.
- For urgent debugging, this makes Tango feel unreliable precisely when it is needed most.

## Expected behavior

For any task that asks for a report, audit, review, findings, test matrix, retrospective, or plan:

1. `done` should imply a retrievable non-trivial deliverable exists.
2. `tango_result` should return the full final answer/report, not a placeholder.
3. `tango_look` or a transcript command should expose the final assistant message if result finalization fails.
4. A short metadata summary should be stored separately and must not replace the deliverable.

## Actual behavior

- Agents reached `done`.
- Metadata summaries implied successful completion.
- Parent notification suggested inspecting `tango_result`.
- `tango_result` and `tango_look` only returned one-line placeholder/completion text.
- Run directories contained no transcript or full report artifact.
- The system detected the result was suspiciously short, but still marked the agent `done` and surfaced it as complete.

## Requested fixes

1. **Persist the full final assistant message by default.** Do not rely solely on explicit `tango_status resultFile` calls for deliverable capture.
2. **Make `done` with `resultRequired=true` fail or block if the persisted deliverable is empty/trivial.** The existing suspicious-short warning should be promoted to a non-success state for report-like tasks.
3. **Separate `summary` from `result`.** Never allow a one-line status summary to overwrite or stand in for the full report.
4. **Add a transcript retrieval path.** Even if `result.md` finalization fails, the parent should be able to inspect the final assistant response.
5. **Improve parent wake-up notifications.** If `resultAssessment.resultWarning` exists, include it in the wake-up message and do not imply the result is ready.
6. **Add role/harness guardrails.** If task text contains `report`, `audit`, `review`, `findings`, `matrix`, `retrospective`, `plan`, or `deliver`, require a minimum non-placeholder deliverable or automatically ask the child to retry finalization.
7. **Encourage or enforce durable output file paths for long reports until the bug is fixed.** In practice, the root session had to restart replacement agents with explicit instructions to write reports into project files.

## Workaround used in this session

The root session had to start replacement agents with explicit durable output paths:

- `roger-docker-dev-friction-retro-2` must write:
  - `/home/joe/Documents/Quantiiv/ROGER/debug/roger-docker-dev-friction-retro-2.md`
- `roger-test-safety-generalist-2` must write:
  - `/home/joe/Documents/Quantiiv/ROGER/debug/roger-test-safety-matrix.md`

A similar replacement may now be needed for `roger-analyst-tool-errors-generalist` unless the parent duplicates the investigation manually.

This workaround should not be necessary for normal Tango operation.

## Priority

High. This directly undermines Tango's core value proposition: delegating bounded research/review work and reliably retrieving child-agent deliverables for parent synthesis.

---

## Additional occurrence: `switchyard-trace-failsafe-generalist`

Role: `generalist`

Run ID: `run_1777278349873_8nfyzo`

Task summary:

- Investigate whether Switchyard trace-store failures such as `sqlite3.DatabaseError: file is not a database` in `hooks_bridge.py` / `sqlite_trace_store.py` are allowed to crash agent execution instead of degrading observability.
- Deliver exact call path, fail-open recommendations, risks, minimal code/test fix, and whether Docker smoke should be blocked.
- Read-only, no source changes.

Tango metadata/status said:

```text
Completed read-only trace-store fail-safe investigation
```

`tango_result` returned only:

```text
Read-only investigation complete. See final response for findings.
```

`resultAssessment` warned:

```text
Result deliverable is suspiciously short for a report/audit/planning task.
```

`tango_look` returned only the same one-line output.

No call path, recommendations, risks, or test plan were retrievable. This is now another fresh occurrence in the same session where a report-style child agent did real work but persisted only a placeholder.
