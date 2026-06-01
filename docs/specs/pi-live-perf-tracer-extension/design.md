# Pi live performance tracer extension idea

## Status

Idea only. No Pi source changes are required or proposed by this spec.

This note captures the abandoned core-source tracer investigation and reframes it as an extension-first diagnostic tool. The upstream Pi source checkout was modified during exploration, but those changes were reverted before this spec was committed.

## Problem

Interactive Pi sessions can become sluggish after long-lived use, subagent activity, extension reloads, or TUI churn. Existing diagnostics are useful but require prior launch flags or capture low-level output rather than live, operator-triggered performance evidence.

We want a live toggle in the current session:

```text
/perf on
/perf off
/perf status
/perf dump [path]
/perf mark <label>
/perf threshold <ms>
```

The operator should be able to enable tracing after noticing lag, reproduce the issue, mark interesting moments, dump a recent trace to a temp JSON file, and then turn tracing off.

## Why not modify Pi source?

A core implementation can cleanly instrument private internals such as `TUI.doRender()`, terminal writes, input dispatch, extension handler execution, and render sub-phases. That is technically the best place for fine-grained, stable telemetry.

However, for this repo's purposes we do **not** want to carry a fork-style Pi source modification just to diagnose local sluggish sessions. Source changes create maintenance burden, require upstream build/install coordination, and couple this diagnostic idea to internal Pi package boundaries.

The source-change experiment also exposed package-boundary concerns: adding core code in `coding-agent` that imports new `pi-tui` exports can break package-local builds unless TUI is rebuilt first. That is avoidable if the tracer lives as a trusted extension instead of changing package APIs.

## Extension-first approach

Create a project-local or global trusted Pi extension, for example:

```text
.pi/extensions/perf-tracer/index.ts
# or
~/.pi/agent/extensions/perf-tracer/index.ts
```

The extension registers `/perf` and maintains an in-memory ring buffer. Hooks are installed once during extension load but are dormant until `/perf on`.

### Commands

| Command | Behavior |
| --- | --- |
| `/perf on` | Enable tracing in the live process. Start health snapshots. |
| `/perf off` | Disable tracing. Keep current ring-buffer contents. |
| `/perf status` | Show enabled state, event count, capacity, threshold, and output defaults. |
| `/perf dump [path]` | Write JSON trace. Default path: `/tmp/pi-perf/pi-perf-<pid>-<timestamp>.json`. |
| `/perf mark <label>` | Record a timestamped marker. Warn if tracing is disabled. |
| `/perf threshold <ms>` | Only record spans at or above the threshold. |

### Event model

Use a compact JSON schema:

```json
{
  "version": 1,
  "dumpedAt": "2026-06-01T00:00:00.000Z",
  "pid": 12345,
  "status": {
    "enabled": true,
    "thresholdMs": 8,
    "events": 120,
    "capacity": 20000,
    "startedAt": "2026-06-01T00:00:00.000Z"
  },
  "events": [
    {
      "kind": "span",
      "name": "tui.render.total",
      "time": 123456.7,
      "durationMs": 18.4,
      "data": { "mode": "monkey-patch" }
    },
    {
      "kind": "mark",
      "name": "mark",
      "time": 123460.1,
      "label": "before-keystroke-lag"
    },
    {
      "kind": "health",
      "name": "process.health",
      "time": 123500.0,
      "data": {
        "rss": 123456789,
        "heapUsed": 45678901,
        "eventLoopUtilization": 0.42,
        "activeResourceCount": 17
      }
    }
  ]
}
```

## What is possible with only public extension APIs?

Public extension APIs are enough for:

- registering `/perf` commands;
- storing ring-buffer state in the extension process;
- writing dumps with Node built-ins;
- sampling process health with `process.memoryUsage()`, `performance.eventLoopUtilization()`, `monitorEventLoopDelay()`, and `process.getActiveResourcesInfo()`;
- observing user-submitted input through the `input` extension event;
- observing tool and model lifecycle events exposed by Pi;
- showing status through `ctx.ui.notify()` or `ctx.ui.setStatus()`.

This gives useful coarse evidence without touching Pi source.

## What requires trusted monkey-patching?

The extension API exposes the TUI object to some UI factories, but it does not provide first-class performance hooks for render internals. A more useful extension can still patch runtime methods in a trusted local environment because TypeScript `private` is erased at runtime.

Possible patches:

- wrap `tui.requestRender()` to count render requests and scheduling pressure;
- wrap `tui.terminal.write()` to measure write duration, byte count, and stdout backpressure;
- wrap runtime-private `tui.doRender()` to measure total render duration;
- wrap runtime-private `tui.handleInput()` or use `ctx.ui.onTerminalInput()` for input timing;
- install a widget/footer factory during `session_start` only to capture a `TUI` reference, then remove or hide the UI element.

This should be clearly marked as trusted, version-coupled instrumentation. It is acceptable for a local diagnostic extension, but not a stable public package contract.

## What extension-only cannot cleanly do

Without Pi source changes or new public hook APIs, an extension cannot cleanly and stably time:

- render sub-phases such as component render, overlay composition, cursor marker extraction, line reset processing, and diff/write assembly;
- every extension handler from inside the central runner;
- all terminal writes made before the extension captures and patches the active `TUI` instance;
- private scheduling state without relying on internal property names.

If those details become necessary, the preferred upstreamable design is not a one-off tracer in core code, but a small supported diagnostic hook surface in Pi's TUI and extension runner.

## Proposed implementation shape

1. Add a `perf-tracer` extension in this monorepo, not in Pi source.
2. Register the `/perf` command family.
3. Keep a dormant tracer object with:
   - `enabled` boolean;
   - threshold milliseconds;
   - fixed-size ring buffer;
   - `mark()`, `span()`, `spanAsync()`, `dump()`, and `status()` helpers.
4. On first `session_start`, capture UI access and install patches where possible.
5. While disabled, patched methods should do only a cheap boolean check and call the original method.
6. While enabled, record spans above threshold and periodic health events.
7. On shutdown or reload, restore original methods if the extension lifecycle allows it.

## Safety and hygiene

- Default dump directory should be a subdirectory: `/tmp/pi-perf/`.
- Dumps may contain local paths, extension paths, and resource names; treat them as local diagnostics.
- The extension should avoid continuous disk writes.
- The extension should not send trace contents to the model by default.
- Hot-path wrappers must avoid metadata allocation while disabled.
- The README should say explicitly that this is a trusted local diagnostic extension, not a supported Pi API guarantee.

## Open questions

- Is `ctx.ui.setWidget()` the cleanest way to capture the active `TUI` instance without rendering visible chrome?
- Can extension reload reliably restore monkey-patched methods before installing a fresh wrapper?
- Should the extension provide a small analyzer command, e.g. `/perf summary`, or keep analysis external to avoid runtime overhead?
- Would upstream Pi accept a minimal public diagnostic hook API so extensions can avoid private monkey-patching?

## Decision

Keep this as an extension idea for now. Do not modify upstream Pi source unless the desired evidence cannot be obtained through public APIs plus trusted local monkey-patching, or unless the diagnostic hook surface is intentionally upstreamed as a stable Pi feature.
