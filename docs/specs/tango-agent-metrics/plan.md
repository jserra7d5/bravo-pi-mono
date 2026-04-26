# Tango Agent Metrics Implementation Plan

Date: 2026-04-26
Status: implemented

## Scope

Implement v1 snapshot-based Tango agent metrics for Pi-harness child agents.

In scope:

- per-run `<runDir>/metrics.json` snapshots;
- internal `tango metrics update` command;
- `tango list --json` / `tango children --json` include metrics snapshots;
- Pi child metrics extension injected for all Tango Pi children;
- child-local metrics footer/status;
- parent Pi TUI list/footer render metrics when available;
- validation for build, CLI, snapshot safety, and dry-run extension injection.

Out of scope:

- durable `agent.metrics` events;
- silence/staleness watchdog;
- Claude/generic metrics;
- public dashboard/history.

## Steps

1. Add `AgentMetricsSnapshot` type.
2. Add metrics helpers for atomic read/write of `<runDir>/metrics.json`.
3. Add `tango metrics update --run-dir ... --json ...`.
4. Ensure JSON list/children output includes metrics snapshots.
5. Add Pi metrics extension with hardened non-blocking handlers and debounced persistence.
6. Inject metrics extension from the Pi harness for every Tango Pi child.
7. Update parent Pi extension renderers/footer to display metrics snapshots.
8. Validate with typecheck/build, CLI smoke tests, dry-run Pi command inspection, and live Pi child metrics snapshot smoke test.

## Result

Implemented snapshot-based v1 metrics:

- `<runDir>/metrics.json` latest metrics snapshot;
- `tango metrics update --run-dir <dir> --payload <json>` internal update command;
- `tango list --json`, `tango children --json`, and `tango wait --json` include metrics when available;
- Pi metrics extension tracks tool calls/results, active tools, last tool, token totals, context usage, and cost;
- Pi harness injects metrics extension for all Pi-harness Tango children;
- parent/child Pi TUI status and list renderers include compact metrics summaries.
