# Terminal UI Research

Status: draft  
Date: 2026-05-17  
Scope: Pi UI APIs and local package patterns for a Bravo Goals terminal HUD.

## Summary

The v1 Bravo Goals HUD should use:

- `ctx.ui.setWidget("bravo-goals-hud", ..., { placement: "belowEditor" })` for the live HUD.
- `ctx.ui.setStatus("bravo-goals", "...")` for a terse footer summary.

Do not use message renderers or tool renderers as the primary HUD surface. Those are transcript/tool-call surfaces, not persistent dashboard surfaces.

## Pi UI APIs

### `setStatus`

Footer/status-bar primitive. Good for one short summary line.

Evidence:

- API: `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/core/extensions/types.ts:140`
- Wiring: `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/modes/interactive/interactive-mode.ts:1654`
- Footer rendering/sanitization: `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/modes/interactive/components/footer.ts:207`

### `setWidget`

Persistent above/below-editor surface. Best v1 surface for the goal HUD.

Evidence:

- API: `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/core/extensions/types.ts:162`
- Implementation: `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/modes/interactive/interactive-mode.ts:1718`
- Keyed replacement/disposal: `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/modes/interactive/interactive-mode.ts:1724`
- Widget container line cap: `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/modes/interactive/interactive-mode.ts:1803`

### `setFooter`

Full footer replacement. Too much blast radius for v1.

Evidence:

- API: `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/core/extensions/types.ts:170`
- Implementation: `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/modes/interactive/interactive-mode.ts:1842`
- Custom footer example: `/home/joe/Documents/misc/pi-mono/packages/coding-agent/examples/extensions/custom-footer.ts:24`

### Message Renderers

Use only for durable transcript cards such as "Judge completed" or "Goal archived", not the live HUD.

Evidence:

- API: `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1171`
- Usage in transcript rendering: `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/modes/interactive/interactive-mode.ts:3014`
- Message shape: `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/core/messages.ts:43`
- Example: `/home/joe/Documents/misc/pi-mono/packages/coding-agent/examples/extensions/message-renderer.ts:14`

### Tool Renderers

Use for `/goal` command/tool rows only, not global status.

Evidence:

- API: `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/core/extensions/types.ts:395`
- Tool row composition: `/home/joe/Documents/misc/pi-mono/packages/coding-agent/src/modes/interactive/components/tool-execution.ts:115`
- Example: `/home/joe/Documents/misc/pi-mono/packages/coding-agent/examples/extensions/built-in-tool-renderer.ts:35`

## Local Package Patterns

### Plan Mode

Pi's plan-mode example uses the recommended split: compact footer status plus below-editor widget.

Evidence:

- `/home/joe/Documents/misc/pi-mono/packages/coding-agent/examples/extensions/plan-mode/index.ts:49`

### Async Subagents

Uses status line plus below-editor live widget, refreshed on timers and cleared on shutdown.

Evidence:

- `/home/joe/Documents/projects/bravo-pi-mono/packages/async-subagents/extensions/pi/statusLine.ts:23`
- `/home/joe/Documents/projects/bravo-pi-mono/packages/async-subagents/extensions/pi/liveWidget.ts:31`
- `/home/joe/Documents/projects/bravo-pi-mono/packages/async-subagents/extensions/pi/index.ts:72`
- cleanup: `/home/joe/Documents/projects/bravo-pi-mono/packages/async-subagents/extensions/pi/index.ts:136`

### Tango

Strongest local reference for polling HUD behavior.

Evidence:

- footer status update: `/home/joe/Documents/projects/bravo-pi-mono/packages/tango/extensions/pi/index.ts:438`
- below-editor live widget: `/home/joe/Documents/projects/bravo-pi-mono/packages/tango/extensions/pi/index.ts:760`
- shutdown cleanup: `/home/joe/Documents/projects/bravo-pi-mono/packages/tango/extensions/pi/index.ts:827`

## Recommended HUD Contract

Footer status:

```txt
Goal: Durable resume loop 4/9 Judge: pass
```

Widget:

```txt
GOAL  Durable resume loop
STATE active
TASK  Implement resume checkpoint writer
DONE  4/9 [########--------] 44%
JUDGE pass
```

The renderer should derive all values from `state.yaml` plus the runtime index. It should not own progress state.

## Refresh and Cleanup

Recommended behavior:

- Poll goal state every 1-2 seconds while a goal is attached.
- Use an `inFlight` guard to avoid overlapping reads.
- Back off or show a muted error after repeated failures.
- Clear interval timers on `session_shutdown`.
- Clear widget/status keys when the session detaches from a goal.

Risks:

- Footer status is one line and may truncate.
- Widget lines are capped at 10 total lines.
- Timer leaks will keep polling after session replacement.
- Custom footer replacement would hide built-in footer telemetry.

