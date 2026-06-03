# Tango done agents with empty result/look despite requested findings

Date: 2026-04-27

## Summary

During a Quantiiv/ROGER eval-debugging session, multiple delegated Tango agents reached `done` status with metadata summaries indicating the work was complete, but the parent/root session could not retrieve any detailed findings. In the latest cases, `tango_result` reported no finalized `result.md`, `tango_look` returned empty output, and the agent run directory contained only metadata/metrics/task/system files — no durable findings artifact.

This is related to, but worse than, the earlier result-loss issue recorded in:

- `/home/joe/Documents/projects/bravo-pi-mono/feedback/tango-agent-result-loss-feedback-2026-04-27.md`

Earlier cases returned only a one-line result. These latest cases returned effectively no usable result at all.

## Observed cases

### 1. `span-issue-investigator`

Role: `general-smart-agent`

Task:

- Investigate two Switchyard/ROGER trace tool-call spans from run `01KQ6PB46ZVT9ZG6EYVQ7DS6FN`.
- Report:
  1. what each tool call attempted,
  2. whether it failed or showed suspicious behavior,
  3. likely root cause,
  4. whether it was relevant to the current rerun,
  5. recommended next action.
- No code changes.

Tango status update said:

```text
span-issue-investigator (general-smart-agent) is done: Completed span investigation; no files edited
Suggested: tango_result span-issue-investigator
```

But `tango_result` returned:

```json
{
  "result": "",
  "resultReady": false,
  "resultIssue": "No finalized deliverable result.md found; only metadata.summary is available."
}
```

`tango_look` also returned empty output:

```json
{
  "output": ""
}
```

The root session had to inspect the trace SQLite database manually to recover the findings.

Manual reconstruction found:

- `span-2f8e38a30c5a437d8af3a4cfffafbcde`: `write_file`, completed, wrote `datasets/ytd_comp_attribution_core.sql`.
- `span-af8afd8845a042259cb0dab92046aaf2`: `python_execute`, failed with `SQLValidationRefusalError` because generated SQL referenced same-scope SELECT aliases `net_sales` and `transactions`.

That was exactly the type of information the child agent had been asked to report, but no child deliverable was retrievable.

### 2. `playbook-task-scope-reviewer`

Role: `general-smart-agent`

Task:

- Read-only review while the root fixed a ROGER playbook materialization failure.
- Inspect:
  - `Quantiiv-Playbooks/base/restaurant-analysis/data-filters.md`
  - `ROGER/scripts/evals/run_full_email_data_worker_eval.py`
  - relevant playbook renderer constraints if needed.
- Deliver concise findings:
  1. remaining unsupported template syntax risks,
  2. exact task-description improvements needed so data workers read rendered playbooks before SQL,
  3. suggested smoke validation command before rerun.
- Do not edit files.

Tango status update said:

```text
playbook-task-scope-reviewer (general-smart-agent) is done: Completed read-only review findings
Suggested: tango_result playbook-task-scope-reviewer
```

But `tango_result` returned:

```json
{
  "result": "",
  "resultReady": false,
  "resultIssue": "No finalized deliverable result.md found; only metadata.summary is available."
}
```

`tango_look` returned empty output.

Inspection of the run directory showed only:

```text
command.json
metadata.json
metrics.json
system.md
task.md
```

No `result.md`, no report artifact, and no visible transcript containing the findings.

## Expected behavior

If a child agent is assigned a research/review/audit task and reaches `done`, the parent should be able to retrieve the final deliverable through at least one reliable path:

- `tango_result <agent>`
- `tango_look <agent>`
- a durable `result.md` in the run directory
- a known transcript/log path
- an artifact path surfaced in metadata

If no final deliverable exists, Tango should not present the agent as successfully done with a completion summary implying findings are ready.

## Actual behavior

For both latest agents:

- Status was `done`.
- Metadata summary implied completion.
- Parent notification suggested `tango_result`.
- `tango_result` had no deliverable.
- `tango_look` had empty output.
- Run directory had no findings artifact.
- Root session had to duplicate the investigation manually.

## Why this is high impact

This breaks the root-session delegation model:

- The parent cannot safely synthesize child-agent findings.
- The parent may believe work is complete because status says so, while the actual evidence is unavailable.
- User-facing work is delayed because the root must reconstruct work manually.
- It creates false confidence in delegated review/research tasks.
- It wastes tokens and wall-clock time.
- It makes Tango unsuitable for audits unless every child is explicitly instructed to write a separate file in the project workspace.

## Suggested product/runtime fixes

1. **Persist the final assistant message by default** for all completed agents.
2. **Make `done` require a retrievable final deliverable** unless the agent was explicitly fire-and-forget.
3. **Separate metadata summary from result content.** A one-line summary should never replace the full deliverable.
4. **Warn or mark incomplete** when a report/review/research task finishes with no `result.md` or empty output.
5. **Expose a transcript command/path** that lets the parent inspect the actual model conversation even if result finalization fails.
6. **Add role/task guardrails**: if task text includes terms like `report`, `findings`, `audit`, `review`, `deliver`, or `recommend`, require a non-empty result artifact.
7. **Improve parent notifications**: do not suggest `tango_result` as the next action if Tango already knows `resultReady=false` or `result.md` is missing.

## Session impact

This occurred while debugging production-representative ROGER data-worker evals. It directly affected:

- investigation of failed/suspicious Switchyard tool-call spans;
- review of playbook template syntax and task scoping after a playbook materialization failure;
- the decision to rerun a three-agent data-worker eval.

Because the delegated reports were unavailable, the root session had to manually inspect SQLite traces, logs, run directories, git diffs, and playbook files to reconstruct what the children should have provided.
