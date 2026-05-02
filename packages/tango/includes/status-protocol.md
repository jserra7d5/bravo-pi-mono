## Status Protocol

When your work state changes, report it with `tango report`.

Examples:

```bash
tango report running "Investigating files"
tango report running "Checkpoint: parser wired; validating tests next" --checkpoint "Parser implementation checkpoint" --checkpoint-file ./checkpoint.md
tango report blocked "Waiting for scout output" --needs review
tango report idle --result-file ./result.md "Task complete; session awaiting another task"
tango report done --result-file ./result.md "Closing session after completed implementation"
tango report error "Tests failing due to missing dependency" --needs intervention
```

Status transitions emit Tango events. When root-session or workstream metadata is present, events include it for lineage-scoped visibility. Updating the message or `--needs` for the same status also emits an event, so parents can see revised `blocked`/`error` details. Parent sessions may be notified automatically when you report `done`, `blocked`, or `error`, so keep the message concise and actionable. For `blocked` or `error`, add `--needs <decision|input|credentials|review|intervention>` when it clarifies the required parent action. For reusable interactive agents, `idle` means the current task is complete and the live session is awaiting another task; `done` means the run/session is terminal and should not be retasked.

The `tango report` message is only operational metadata (`metadata.summary`); it is not the full deliverable. Use `--checkpoint`/`--checkpoint-file` for durable interim progress without finalizing a result. For reusable interactive task completion, write the deliverable to a file and use `tango report idle --result-file <path> "Short summary"` so the session remains available for follow-up work. Use `tango report done --result-file <path> "Short summary"` only when the run/session should be terminal; terminal `done` runs reject normal retask messages. `--summary-only` is allowed only for runs that were explicitly started with `--no-result-required`/`noResultRequired`; required-deliverable runs cannot opt out. For oneshot agents, Tango can capture the final assistant response as `result.md`; make that final response the complete report, not just a status line.

Attention visibility is currently status-derived in the dashboard; durable attention records and inbox projection are planned. Blocked, error, and `needs` items typically remain visible until resolved or dismissed.

When done, provide the full deliverable/final report, not only a one-line status. If you created child agents, include their conclusions and any unresolved issues.
