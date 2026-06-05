# Monitor event inline output feedback — 2026-06-05

## Observation

When a monitor fires an event, the wakeup currently gives the monitor ID/name/kind/state and an `Output:` path, then instructs the agent to inspect that file with the read tool if needed.

Example shape:

```text
[MONITOR EVENT — NOT USER INPUT]
Monitor ID: mon-...
Name: durable-context-email-rerun-returns
Kind: poll
State: event
Output: /home/joe/.pi/monitor/monitors/.../output.log

Instructions:
- Inspect Output path with the read tool only if needed.
```

For state-change poll monitors, the useful payload is often a compact one-line JSON/state summary already written to the output log. Requiring an extra read call adds latency and friction, especially during live validation loops.

## Suggestion

Include a small inline tail/preview of the monitor output in the event wakeup itself.

Possible design:

- For `emit: state_change`, include the new state line inline, capped at a small budget such as 2–8KB.
- For line/event stream monitors, include the last N new lines since the previous wakeup.
- Preserve the output path for full history/recovery.
- Mark the inline content as a preview, not the canonical full log.

Example improved wakeup:

```text
[MONITOR EVENT — NOT USER INPUT]
Monitor ID: mon-...
Name: durable-context-email-rerun-returns
State: event
Output: /path/to/output.log

Latest output preview:
{"scenarios":[...],"replies":2,"missing":0}
```

## Why it helps

- Lets the agent decide immediately whether the event is actionable.
- Avoids one extra tool round-trip for the common case where the latest output line is enough.
- Makes monitor wakeups more useful in live ops/debug workflows.
- Still keeps full output file semantics for larger logs, history, or forensic inspection.

## Guardrails

- Cap preview size aggressively.
- If output is truncated, say so explicitly.
- For sensitive monitors, allow a monitor option to disable inline previews.
- Avoid replaying large unchanged output on every wakeup; show only newly emitted lines or state diff when possible.
