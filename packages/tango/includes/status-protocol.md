## Status Protocol

When your work state changes, report it with `tango status`.

Examples:

```bash
tango status running "Investigating files"
tango status blocked "Waiting for scout output" --needs review
tango status done "Completed implementation plan"
tango status error "Tests failing due to missing dependency" --needs intervention
```

Status transitions emit Tango events. Updating the message or `--needs` for the same status also emits an event, so parents can see revised `blocked`/`error` details. Parent Pi sessions may be notified automatically when you report `done`, `blocked`, or `error`, so keep the message concise and actionable. For `blocked` or `error`, add `--needs <decision|input|credentials|review|intervention>` when it clarifies the required parent action.

When done, provide a concise final summary. If you created child agents, include their conclusions and any unresolved issues.
