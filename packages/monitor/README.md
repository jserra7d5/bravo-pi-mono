# @bravo/monitor

Durable monitor tools for Pi sessions.

## Tool usage

- Use `monitor_start` for all new monitors.
- Use `check.type: "timer"` or `check.type: "file"` for scheduled checks and inspect their check results with `monitor_result`.
- Use `check.type: "command"` for durable shell-command monitors and inspect stdout/stderr with `monitor_output`.
- Use `monitor_stop` to stop monitors. Command monitors are stopped as a POSIX process group with SIGTERM then SIGKILL escalation before stopped state is persisted.
- Use `monitor_list` and `monitor_look` to recover IDs and inspect state.
- Use `monitor_attention` and `monitor_ack` for unacked triggered/error results.

Command monitor example:

```json
{
  "name": "build watch",
  "check": {
    "type": "command",
    "command": "npm test -- --watch=false",
    "event_throttle_ms": 1000,
    "max_lines_per_turn": 20
  },
  "schedule": {},
  "attention": { "notify": false, "wake_agent": false }
}
```

Then read output:

```json
{ "monitor_id": "mon-...", "block": true, "timeout_ms": 5000 }
```

`attention.notify` controls UI notifications. `attention.wake_agent` controls follow-up messages that wake the agent. Quiet command monitors still capture output to `~/.pi/monitor/streams/<monitor_id>.log`.

## Prompt guidance

The extension appends monitor-specific system prompt guidance at `before_agent_start` when monitor tools are selected. That guidance teaches agents to prefer `monitor_start` + `monitor_output` for command monitors and to use `monitor_result` for timer/file check results.
