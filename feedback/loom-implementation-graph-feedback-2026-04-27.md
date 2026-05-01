# Loom feedback: implementation graph planning session

Date: 2026-04-27
Source project: `/home/joe/Documents/Quantiiv/ROGER-Run-Viewer`
Loom: `live-run-observatory`

## Context

While building out the Live Run Observatory implementation graph, I delegated three concurrent planner agents to write Loom nodes/notes under the same Loom:

- `impl-plan-schema-workstream`
- `impl-plan-runtime-workstream`
- `impl-plan-ui-validation-workstream`

The goal was to decompose implementation planning under `N-0028` into schema/normalization, live server/Switchyard, UI/provider, and validation workstreams.

## What worked well

- Loom was effective as the durable planning surface once writes succeeded.
- The resulting graph is useful and readable:
  - Phase 1 live server tasks under `N-0030`.
  - Phase 2 Switchyard client tasks under `N-0031`.
  - Phase 3 UI/provider tasks under `N-0032`.
  - Phase 4 component hardening tasks under `N-0033`.
  - Phase 5 validation/review tasks under `N-0034`.
  - Schema/normalization tasks `N-0062`–`N-0075` under `N-0028`.
- Node-local notes are a good place to capture implementation scope, target files, validation, and stop conditions.

## Main issue: concurrent write lock contention

The three planner agents wrote to the same Loom concurrently. This produced repeated lock failures and stuck processes:

- Multiple `loom note` and `loom link` commands reported `LOCK_TIMEOUT: could not acquire Loom lock`.
- Some child agents remained `running` even after useful node creation had happened because their shell commands were blocked/retrying on Loom locks.
- I had to stop the agents manually with Tango and then inspect/kill leftover Loom-related shell/node processes.
- A stale lock directory remained:
  - `.loom/looms/live-run-observatory/runtime/loom.lock`
  - `meta.json` referenced a PID that no longer existed.
- I manually removed the stale lock after verifying the PID was dead.

## Suggested improvements

### 1. Make stale lock recovery first-class

Add a safe Loom command for lock diagnosis/recovery, for example:

```bash
loom lock status
loom lock clear-stale
```

Expected behavior:

- Show lock holder PID, host, age, command if available.
- Verify whether PID is alive on same host before clearing.
- Refuse unsafe clear if host differs or PID is alive unless forced.
- Provide clear guidance in `LOCK_TIMEOUT` output.

### 2. Better lock timeout errors

Current `LOCK_TIMEOUT` is terse. It would help if errors included:

- lock path,
- lock holder PID/host/time,
- age of lock,
- suggested recovery command,
- whether the holder PID appears alive.

Example:

```text
LOCK_TIMEOUT: could not acquire Loom lock
holder: pid=2043369 host=joe-desktop age=4m12s alive=false
run: loom lock clear-stale
```

### 3. Agent-safe write serialization

For multi-agent planning, Loom could provide a command or mode that serializes writes more gracefully:

```bash
loom batch --stdin
loom note --wait-lock 120 ...
loom create --wait-lock 120 ...
```

This would reduce failure loops when multiple agents are creating nodes/notes in parallel.

### 4. Batch operations for graph construction

Implementation graph creation often needs many related operations:

- create node,
- add note,
- add dependency edges,
- maybe add artifacts/references.

A batch transaction format would be helpful, e.g. JSON/YAML:

```yaml
nodes:
  - parent: N-0028
    title: Schema ADR/spec consolidation
    kind: task
    note: |
      Objective...
edges:
  - from: N-0063
    type: depends_on
    to: N-0062
```

This would:

- acquire the lock once,
- avoid interleaved partial writes,
- make generated implementation graphs more reproducible,
- reduce lock contention dramatically.

### 5. Duplicate edge handling

Some dependency links were attempted more than once after retries. It would help if `loom link` were explicitly idempotent or reported duplicate edges as success/no-op.

Desired behavior:

```text
edge already exists; no-op
```

with exit code 0.

### 6. Better planner guidance for concurrent Loom writers

The Loom skills or docs should warn that concurrent writers to the same Loom can contend heavily. Recommended pattern:

- Use scouts/planners to produce proposed graph patches without writing; then
- Have one coordinator apply Loom writes serially; or
- Use a future `loom batch` command.

### 7. Tango integration hint

When a child agent is stuck in a long-running `loom` command due to lock contention, Tango status remained `running`. It would be useful if Loom lock waits emitted enough output for Tango/parent agents to detect and intervene sooner.

## Workaround used

1. Stopped stuck Tango agents.
2. Killed leftover Loom shell/node processes.
3. Checked stale lock metadata.
4. Verified lock PID was not alive.
5. Removed `.loom/looms/live-run-observatory/runtime/loom.lock` manually.
6. Re-ran/continued Loom writes serially from the root session.

## Recommendation

For now, use a single writer/coordinator for Loom graph mutations during large implementation planning sessions. Delegated agents can still propose node lists and notes, but one process should apply them serially until Loom has batch writes or safer lock handling.

---

## Additional feedback from Tango server/dashboard Loom session

Date: 2026-04-27
Source project: `/home/joe/Documents/projects/bravo-pi-mono`
Loom: `tango-server-dashboard` / `lm_z62olhbb`

### 8. `loom create` argument order is easy to misuse

I accidentally created a node with title `task`:

```bash
loom -L lm_z62olhbb create task "Update Tango prompt modules for server and root-session semantics" --parent N-0001 --json
```

Actual result:

```txt
N-0017 title: task
kind: task
summary: task
```

Expected by a user coming from many CLIs: first positional might be kind, second positional title. Actual CLI expects title as the first positional and `--kind task` as a flag.

Suggested improvements:

- Reject suspicious invocations like `loom create task "..."` when the first positional is a known kind and `--kind` is absent.
- Print a hint:

```text
Did you mean: loom create "Update Tango prompt modules..." --kind task ?
```

- Consider accepting `loom create task "Title"` as an alias if that fits the CLI design.

### 9. No obvious node rename/delete/supersede command

After creating the bad `N-0017` node, I did not see an obvious safe command to rename, cancel, delete, or mark it superseded. I worked around it by adding a note saying it was accidental and superseded by `N-0018`.

Suggested commands:

```bash
loom update N-0017 --title "..." --summary "..."
loom cancel N-0017 --reason "created accidentally"
loom supersede N-0017 --by N-0018 --reason "wrong title"
```

Important: this should be a first-class graph event, not direct markdown editing.

### 10. Node parent/link state can be confusing

Some nodes created/linked earlier displayed `parent: null` even though they were intended to be decompositions of `N-0001` and had graph links. This made `loom tree N-0001` and `loom show` feel inconsistent.

Suggested improvement:

- Clarify the distinction between frontmatter `parent` and graph `edges` in `show` output.
- If `decomposes_to` is intended to imply parentage, update frontmatter or show a derived parent/decomposition section.
- Add a consistency command:

```bash
loom doctor graph
```

that reports nodes linked as children but missing `parent`, duplicate decomposition edges, orphaned review nodes, etc.

### 11. Reference output showed `workspace: "undefined"`

`loom reference list N-0001` printed references with:

```json
{"workspace":"undefined", ...}
```

This looked harmless, but it is confusing and makes it unclear whether the reference is malformed.

Suggested improvement:

- Omit `workspace` when unset, or use `null`.
- Validate that string literal `"undefined"` is not persisted.

### 12. `loom note` makes accidental/probe notes too easy

A planner agent accidentally added a tiny probe note while checking `loom note` syntax, then added a full note that superseded it. This is recoverable but noisy in durable history.

Suggested improvements:

- Add `--dry-run` to note/create/link commands.
- Add `loom note --replace-last` or `loom note edit-last` for same-author immediate correction within a short window, if compatible with audit goals.
- Alternatively add a first-class `loom note retract <event-id>` command that preserves audit history but hides/retracts the note in normal views.

### 13. `loom show` can be too verbose for agent control loops

For readiness and coordination, agents often need just frontmatter, edges, references, and recent notes. Full bodies can be large and push agents toward brittle `sed`/`grep` pipelines.

Suggested command:

```bash
loom show N-0003 --summary --recent-notes 3 --json
```

or:

```bash
loom context N-0003 --brief --json
```

This would help agents make routing/coordination decisions without over-reading.

### 14. Need better task-state transitions for implementation coordination

During implementation, I wanted to mark states such as:

- ready for implementation,
- implementation running,
- blocked by review,
- fixed after review,
- validated,
- ready for dependent task.

Current workaround is notes only. This loses machine-readable workflow state.

Suggested improvement:

```bash
loom state N-0002 --state implementing
loom state N-0012 --state blocked --reason "resolver fallback issue"
loom state N-0002 --state validated --validation "npm test ..."
```

or support a richer workflow extension while retaining simple `open/resolved` states.

### 15. Review findings should be attachable as structured review outcomes

For `N-0012`, the reviewer returned `BLOCKED` with explicit findings. I recorded them manually as a note. It would be useful for Loom to have review outcome semantics:

```bash
loom review N-0012 --target N-0002 --outcome blocked --stdin
loom review N-0012 --target N-0002 --outcome pass --validation "npm test ..."
```

This would make it easier to query “which tasks are blocked by review?” and “which reviews passed after fixes?”

### 16. Agent result summaries can be too terse for durable handoff

Some Tango/Pi child agents reported a useful status but wrote only a terse `result.md`, requiring me to inspect raw `output.log`. This is not strictly a Loom CLI issue, but Loom-backed workflows would benefit from a standard agent result contract when agents are asked to mutate Loom:

- what nodes changed,
- what notes/edges/references were added,
- validation commands/results,
- blockers,
- next recommended node.

Suggested Loom skill/doc update: require agents doing Loom writes to include a final structured result matching those fields.
