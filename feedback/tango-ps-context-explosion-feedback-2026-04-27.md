# Tango `ps --all` / Pi wrapper can flood parent context and destabilize agents

Date: 2026-04-27

## Summary

While checking whether delegated Tango agents were still healthy, the root Pi session used the Tango Pi `tango_ps` wrapper. A scoped `tango_ps(all=false)` in the active ROGER project returned no agents, so the session escalated to `tango_ps(all=true)` from `/home/joe/Documents/Quantiiv`.

The global `ps` response was extremely large — effectively a cross-context dump of many historical/current runs — and it blew up the parent agent context by roughly hundreds of thousands of tokens. The resulting context pressure made the root session unstable and caused/preceded agent errors. This made a simple health-check operation dangerous.

## What happened

1. User asked whether all Tango agents/tasks were still running fine.
2. Root session called:
   - `tango_ps(all=false)` with cwd `/home/joe/Documents/Quantiiv/ROGER`.
   - It returned no agents for that project/context.
3. Root session then called:
   - `tango_ps(all=true)` from `/home/joe/Documents/Quantiiv`.
4. The response included a very large global list of Tango runs across contexts, including old/stopped/failed/created entries.
5. The tool output consumed an enormous portion of model context, on the order of ~200k tokens according to the observed failure mode/user report.
6. The session then had to recover from a compacted history, and delegated-agent status tracking was interrupted/errored.

## Expected behavior

A status/listing command should be safe to call from an agent, even with `--all`:

- It should not emit unbounded run metadata into the model context.
- It should default to concise fields suitable for health checks.
- It should paginate, summarize, or cap output.
- It should warn before returning huge output.
- It should provide a machine-readable summary such as counts by state and a small recent/current subset.
- It should make it easy to ask, “which descendants/current-workstream agents are running/blocked/error/done?” without dumping every historical run.

## Actual behavior

- `tango_ps(all=true)` returned a very large raw result set.
- The Pi tool forwarded that result directly into the conversation context.
- The output was large enough to blow up context and destabilize the parent/root agent.
- The user-facing health-check task was derailed by the observability command itself.

## Impact

This is high severity for agent orchestration UX:

- A routine “are my agents OK?” operation can destroy useful working context.
- Parent sessions can lose track of active workstreams during recovery/compaction.
- Child-agent errors or lost status may be misdiagnosed because the status command itself is the trigger.
- Users lose trust in Tango as a safe control plane.
- Agents become reluctant to inspect global status, even when global status is needed to find misplaced lineage/cwd-scoped children.

## Root-cause hypothesis

The CLI/tool boundary lacks output budgeting and health-check-specific views:

- `ps --all --json` appears optimized for complete machine state, not model-context safety.
- The Pi wrapper returns full JSON directly, without truncation/summarization by default.
- There is no built-in compact health view that answers the common parent question: active descendants/current workstream plus exceptions.
- Old historical runs are included alongside current runs, which multiplies output size and reduces signal.

## Suggested fixes

### 1. Add bounded/default-safe `ps` output for agents

For Pi/Tango-agent wrappers, make `tango_ps(all=true)` safe by default:

- Return counts by state: `running`, `blocked`, `error`, `done`, `stopped`, `created`, etc.
- Include only a capped list, e.g. active/problem runs first, then recent completed runs.
- Include a `truncated: true` flag and `totalRuns` count when capped.
- Include instructions for narrowing if data was omitted.

### 2. Add a dedicated health command/view

Add something like:

```bash
tango health --json
```

or options on `ps`:

```bash
tango ps --health --json
tango ps --active --problems --json
tango ps --descendants --json
```

The output should answer:

- Which agents are currently `running`, `blocked`, or `error`?
- Which expected children are terminal?
- Which terminal children have missing/suspicious results?
- Which agents need parent attention?

### 3. Require explicit pagination for full historical dumps

For `--all` with large result sets:

- Default limit should be small, e.g. 50 or 100.
- Support `--limit`, `--offset`/`--cursor`, and `--state` filters.
- Refuse or warn if a command would emit more than a safe byte/token threshold unless an explicit `--unbounded` or `--full` flag is passed.

### 4. Add Pi wrapper-side output guardrails

The Pi tool should protect the model even if the CLI returns too much:

- Detect oversized JSON/string payloads.
- Summarize or truncate before insertion into context.
- Save the full raw output to a temp artifact/file and return a path.
- Present a compact preview plus counts.

### 5. Make lineage-aware status easier than global fallback

The root cause of using `all=true` was that scoped `ps` returned no relevant agents from the current cwd even though the session had active work elsewhere/under lineage. Improve discovery so agents do not need global dumps:

- Prefer root-session/workstream/lineage resolution automatically.
- Provide `tango children --tree --json` through Pi tools.
- Add `tango ps --lineage --json` or make it the default in parent sessions.

## Reproduction sketch

From a workspace with many Tango run records:

```python
# Pi tool call / equivalent CLI behavior
# 1. Scoped listing returns empty or misses expected children.
tango_ps({"all": false, "cwd": "/home/joe/Documents/Quantiiv/ROGER"})

# 2. Agent escalates to global listing.
tango_ps({"all": true, "cwd": "/home/joe/Documents/Quantiiv"})

# 3. The tool returns a huge global JSON payload directly into model context.
```

## Severity

High. This is not just noisy output; it can consume the parent context budget, force compaction, and interrupt active delegated work. Observability commands should be among the safest operations in Tango.

## Requested outcome

Make Tango status inspection model-safe by default. Full raw global run dumps should remain possible for humans/debugging, but Pi/agent-facing paths should return compact summaries, paginate, and protect context automatically.
