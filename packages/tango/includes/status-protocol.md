## Status Protocol

When your work state changes, report it with `tango status`.

Examples:

```bash
tango status running "Investigating files"
tango status blocked "Waiting for scout output" --needs review
tango status done "Completed implementation plan"
tango status error "Tests failing due to missing dependency" --needs intervention
```

Status transitions emit Tango events. When root-session or workstream metadata is present, events include it for lineage-scoped visibility. Updating the message or `--needs` for the same status also emits an event, so parents can see revised `blocked`/`error` details. Parent sessions may be notified automatically when you report `done`, `blocked`, or `error`, so keep the message concise and actionable. For `blocked` or `error`, add `--needs <decision|input|credentials|review|intervention>` when it clarifies the required parent action.

The `tango status` message is only operational metadata (`metadata.summary`); it is not the full deliverable. For short/simple deliverables, write the report to a file and finish with `tango status done --result-file <path> "Short summary"`. For longer work, ensure your final assistant response contains the complete report so the harness can persist it as `result.md`.

Attention visibility is currently status-derived in the dashboard; durable attention records and inbox projection are planned. Blocked, error, and `needs` items typically remain visible until resolved or dismissed.

When done, provide the full deliverable/final report, not only a one-line status. If you created child agents, include their conclusions and any unresolved issues.
