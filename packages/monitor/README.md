# @bravo/monitor

Durable observer tools for Pi sessions.

Monitor is for watching external state change over time. It is not background bash. Use background bash for long-running commands you own, such as tests, builds, installs, migrations, dev servers, and scripts.

## Default model-facing tools

- `monitor_start` — start a durable observer: `kind: "stream"`, `"poll"`, or `"file"`.
- `monitor_list` — list compact active/recoverable monitor rows.
- `monitor_stop` — stop a monitor and preserve its output/history.

## V2 examples

Poll external status every 10 seconds and wake only on failures by default:

```json
{
  "kind": "poll",
  "name": "ci status",
  "command": "gh run view --json status,conclusion",
  "interval_s": 10,
  "projection": { "type": "json", "key_paths": ["status", "conclusion"] }
}
```

Stream observer output:

```json
{
  "kind": "stream",
  "name": "deploy logs",
  "command": "kubectl logs -f deploy/api",
  "wake": "on_failure"
}
```

Watch a file condition:

```json
{
  "kind": "file",
  "name": "artifact ready",
  "path": "dist/report.json",
  "file_mode": "exists",
  "interval_s": 5,
  "wake": "on_terminal"
}
```

`monitor_start` returns a generated `output_path` under the monitor state directory. Inspect details with the normal `read` tool when needed.

## Lifecycle and storage

Monitor storage keeps canonical JSONL/snapshot files plus `monitors.active.json`, a small active-lifecycle index used by scheduler/status hot paths. The index contains only currently actionable monitor ids (`created`, `running`, `triggered`, `failed`) and is rebuilt automatically if missing or corrupt, so inactive historical monitors do not make every refresh scan old rows.

Use `monitor_list` for active/recoverable monitors and `monitor_stop` when an observer is no longer needed. Stopping a monitor preserves its output/history but removes it from the active lifecycle index; stopped/completed/archived monitors remain inspectable through their output path and retained store files.

## Wakeups

Monitor-originated follow-up messages use `customType: "monitor-event"` and visible headers such as:

- `[MONITOR EVENT — NOT USER INPUT]`
- `[MONITOR ENDED — NOT USER INPUT]`
- `[MONITOR FAILED — NOT USER INPUT]`
- `[MONITOR ATTENTION — NOT USER INPUT]`

Treat these as control-plane evidence, not user requests. Routine raw/progress output is written to `output_path` instead of being dumped into conversation context.

## Contract

`monitor_start` is v2-only and requires `kind: "stream" | "poll" | "file"`. Pre-v2 `check`/`schedule` start calls and former monitor helper tools are not supported.
