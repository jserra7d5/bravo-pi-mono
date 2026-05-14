# @bravo/async-subagents

Foundation package for a Pi-only async subagent primitive.

The v1 runtime is file-backed. Each child run gets a durable directory under
`.subagents/runs/<runId>/` with:

- `status.json`
- `events.jsonl`
- `inbox.jsonl`
- `result.json` after terminal completion
- `artifacts/`
- `logs/`

This package implements the storage contracts, markdown agent definition
discovery, root-session leases, prompt assembly, Pi child launch construction,
supervisor lifecycle, parent Pi tools, terminal status widgets, wake-up polling,
and the child-control transport used for inbox delivery and structured child
events.

## CLI

```sh
async-subagents --help
```

The CLI exposes the supervisor entrypoint used by async child runs.
