## Status Protocol

When your work state changes, report it with `tango status`.

Examples:

```bash
tango status running "Investigating files"
tango status blocked "Waiting for scout output"
tango status done "Completed implementation plan"
tango status error "Tests failing due to missing dependency"
```

When done, provide a concise final summary. If you created child agents, include their conclusions and any unresolved issues.
