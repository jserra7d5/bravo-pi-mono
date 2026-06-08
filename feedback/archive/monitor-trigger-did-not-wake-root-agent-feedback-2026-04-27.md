# Monitor trigger did not visibly wake root Pi agent

Date: 2026-04-27

## Summary

A root Pi session created durable monitors with `wake_agent: true` and `notify: true` to track a Tango child agent's checkpoint/result files. Both monitors reached `triggered`, but the root agent was not visibly/proactively awakened in the conversation. The user had to ask whether the monitor notification was received.

When manually inspected, both monitors were indeed triggered, and both watched files existed. This suggests the monitor backend/checker worked, but the wake/notification delivery path to the active root Pi conversation failed or was not surfaced clearly.

## Context

The root session was coordinating a Tango workstream in:

```text
/home/joe/Documents/Quantiiv/ROGER
```

A child Tango agent was started:

```text
name: phase0-commit-curator
runDir: /home/joe/.tango/runs/ROGER-574d7031/phase0-commit-curator
```

The agent was tasked with curating and committing completed Phase 0 work. Because prior Tango status/listing had caused context pressure, the root used monitors instead of polling broad status.

## Monitor setup

### Checkpoint monitor

```text
monitor_id: mon-d347c3e1ef14
name: phase0 commit curator checkpoint
path: /home/joe/Documents/Quantiiv/ROGER/debug/phase0-commit-curator-checkpoint.md
mode: exists
attention.notify: true
attention.wake_agent: true
message: phase0-commit-curator checkpoint file exists; inspect it before/while commit proceeds.
```

### Result monitor

```text
monitor_id: mon-29dbfb08624a
name: phase0 commit curator result
path: /home/joe/.tango/runs/ROGER-574d7031/phase0-commit-curator/result.md
mode: exists
attention.notify: true
attention.wake_agent: true
message: phase0-commit-curator result.md exists; inspect result and continue next phases.
```

## What happened

1. Root started `phase0-commit-curator`.
2. Root created the checkpoint and result monitors with `notify: true` and `wake_agent: true`.
3. Root observed the child was running and returned to the user.
4. The child later wrote:
   - `/home/joe/Documents/Quantiiv/ROGER/debug/phase0-commit-curator-checkpoint.md`
   - `/home/joe/.tango/runs/ROGER-574d7031/phase0-commit-curator/result.md`
5. The user asked: “did you not get the monitor notification?” and then “did it not wake you?”
6. Root manually inspected monitor state:
   - `monitor_look(mon-d347c3e1ef14)` returned `state=triggered`.
   - `monitor_look(mon-29dbfb08624a)` returned `state=triggered`.
7. Root manually read the checkpoint/result files and confirmed the child had completed successfully.

## Expected behavior

When a session-scoped monitor with `attention.wake_agent: true` triggers:

- The active/root Pi agent should be visibly woken or receive an attention event.
- The wake message should appear in the conversation or be delivered as an actionable notification.
- The root should not require a user prompt to discover the triggered monitor.
- If waking cannot be delivered, the monitor result should record delivery failure/reason.

## Actual behavior

- Both monitors reached `triggered`.
- No visible wake-up occurred in the root conversation before the user asked.
- The root only discovered the trigger by manually calling monitor inspection tools.
- There was no obvious delivery-failure signal in the surfaced monitor state.

## Impact

This undermines the intended workaround for Tango polling/context risks:

- Root agents cannot rely on monitors for hands-off child completion tracking.
- Users have to babysit monitor-triggered work.
- Agents may leave completed child work idle despite a triggered monitor.
- It increases pressure to poll Tango status, which previously caused a severe context explosion with `tango ps --all`.

## Root-cause hypothesis

The monitor scheduler/checker correctly detects conditions, but one of these paths is incomplete or unreliable:

1. session-scoped monitor-to-root-session routing,
2. `wake_agent` delivery into Pi active conversation,
3. notification rendering/surfacing in Pi,
4. monitor attention event persistence/querying,
5. or root agent liveness/availability detection.

The problem appears to be delivery/surfacing, not condition detection.

## Requested fixes

1. **Guarantee visible delivery for `wake_agent: true`.** If a monitor triggers and requests waking, the root session should receive an unmistakable message/event.
2. **Record delivery status.** Monitor results should include fields such as `wakeAttempted`, `wakeDelivered`, `wakeError`, `targetSession`, and timestamp.
3. **Expose pending monitor attention.** Root sessions should have a compact way to see triggered unacknowledged monitors without polling every monitor manually.
4. **Clarify semantics.** Document whether `wake_agent` is best-effort, requires a particular active harness, or only works under certain session states.
5. **Add idempotent wake retries.** If root wake delivery fails transiently, retry or keep an attention item pending until acknowledged.
6. **Integrate with Tango child workflows.** Since monitors are used to avoid expensive/status-dump polling, they should be reliable enough to track child result files and checkpoint flags.

## Severity

Medium-high. The file monitors themselves worked, but the wake semantics did not do what an agent/user would reasonably expect. In multi-agent workflows, missing wakeups can stall implementation and force unsafe polling patterns.
