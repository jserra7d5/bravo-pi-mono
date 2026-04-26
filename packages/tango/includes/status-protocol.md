## Status Protocol

When your work state changes, report it with `tango status`.

Examples:

```bash
tango status running "Investigating files"
tango status blocked "Waiting for scout output"
tango status done "Completed implementation plan"
tango status error "Tests failing due to missing dependency"
```

Status updates emit Tango events. Parent Pi sessions may be notified automatically when you report `done`, `blocked`, or `error`, so keep the message concise and actionable.

When done, provide a concise final summary. If you created child agents, include their conclusions and any unresolved issues.
