# Tango A2A Coordination Cleanup Design

Status: draft  
Date: 2026-04-29  
Scope: raw Tango CLI semantics, Pi tool/TUI integration, result retrieval, wait/follow semantics, direct-child/recursive board projection, and remaining inbox/attention cleanup.

Related specs:

- `docs/specs/tango-coordination-board-inbox/design.md`
- `docs/specs/tango-coordination-board-inbox/plan.md`
- `docs/specs/tango-pi-live-tui/design.md`

## Problem

Tango now has the right primitives emerging — board, inbox, structured messages, stable run IDs, root sessions, and workstreams — but several user-facing coordination semantics remain muddy:

- Raw CLI has overlapping result commands (`result`, `collect-results`) and unclear collection behavior.
- `follow` is overloaded and has bad condition semantics; notably, `terminal` has been treated too close to `blocked`, even though blocked agents can resume.
- There is no reliable first-class way to wait on any/all target sets across children, descendants, result readiness, attention, or inbox events.
- Pi integration should use tools and custom renderers for a rich UI, but raw CLI still needs clean, predictable semantics for Claude Code, shell agents, humans, and automation.
- Recursive delegation should be visible without overwhelming the root session: direct delegated agents should be primary, with descendant aggregates under their owning delegate.
- The TUI design must remain part of this cleanup, not an afterthought.

## Goals

1. **Clean raw CLI semantics**
   - Raw `tango` commands should be understandable and scriptable without Pi.
   - CLI output should preserve full result contracts and stable JSON shapes.

2. **Pi uses tools for rich rendering**
   - Pi-specific integration should prefer structured tools (`tango_result`, `tango_wait`, `tango_board`, `tango_inbox`) over raw shell commands.
   - Tools can render live cards, widgets, and overlays without compromising raw CLI behavior.

3. **One result retrieval model**
   - `tango result` is the single result-content command.
   - Canonical results are never truncated by Tango.
   - Inbox result collection folds into `tango result --unread` / `--inbox` rather than a separate primary command.

4. **First-class wait semantics**
   - Add `tango wait` for any/all waits over explicit targets and target sets.
   - Conditions are explicit and not overloaded.
   - `follow` becomes a thin single-target compatibility/developer convenience or is renamed/deemphasized.

5. **Direct-child UI model with recursive aggregates**
   - Root Pi TUI shows immediate delegated agents only by default.
   - Descendants are summarized as aggregate counts under their owner.
   - Delegation-capable agents are labeled clearly, e.g. `L` or `(L)`.

6. **Inbox is the durable attention queue**
   - Board is derived status.
   - Inbox is durable attention/action state.
   - Message records are communication history.
   - Legacy attention/subscription concepts should not leak into user-facing semantics.

## Non-goals

- Replacing Tango's runtime model.
- Making the Pi TUI the source of truth.
- Forcing all harnesses through Pi tools.
- Preserving legacy `collect-results`, subscription, or ambiguous follow behavior if it conflicts with the cleaner model.
- Displaying every recursive descendant as a default row in the compact TUI widget.

## Architectural principle: raw CLI and Pi tools are different surfaces

Tango should have two complementary integration layers:

### Raw CLI

For humans, shell scripts, Claude Code Bash, generic harnesses, and debugging.

Raw CLI properties:

- complete and stable semantics;
- full canonical data available by default where expected;
- JSON suitable for automation;
- no reliance on Pi TUI rendering;
- good errors and timeout shapes;
- server-first when available, but file/local fallback should preserve semantics.

### Pi tools/TUI

For Pi agent-native interaction.

Pi integration properties:

- tools wrap CLI/server behavior with structured parameters;
- custom renderers make results and messages visually useful;
- live widget/overlay shows state without polluting conversation history;
- automatic wake-ups use inbox-backed custom messages, not raw protocol text;
- LLM-visible tool results can be concise or full depending on the tool contract, but canonical result retrieval still returns full content.

This split avoids a bad compromise where raw CLI output is contorted for TUI display or Pi tools expose raw shell UX.

## Result command cleanup

### Smell

Current/near-current UX has multiple ways to retrieve results:

- `tango result <target>`
- `tango collect-results`
- inbox result items
- direct `result.md` file reading
- activity log archaeology

This is too many paths for one contract.

### Desired contract

`result.md` is durable internal storage and a recovery/debug artifact. It is not the normal user/agent workflow.

The primary contract is:

```bash
tango result <target>
```

returns the full canonical result for one target and marks matching result inbox items handled by default.

Tango itself should never truncate canonical result output. Presentation layers may preview, but retrieval must remain complete.

### Proposed CLI

```bash
tango result <name|run-id|run-dir>
tango result --run-id <id>
tango result --run-dir <dir>
```

One result. Full content. Marks corresponding result inbox items handled by default.

```bash
tango result --unread
```

Returns full results for all unread result inbox items in scope and marks those items handled.

```bash
tango result --inbox <inbox-id>
```

Returns the full result associated with one inbox item and marks it handled.

```bash
tango result --peek <target|--unread|--inbox id>
```

Reads without marking handled.

Possible utility options, explicitly secondary:

```bash
tango result <target> --json
tango result <target> --save <file>
tango result <target> --metadata-only
```

Rules:

- `--json` includes full `result` content unless `--metadata-only` is set.
- `--save` writes the full result to a chosen path and still reports metadata.
- `--metadata-only` is for constrained automation; it is not the default recommendation.
- `--path` may exist as debug/interop sugar, but docs should not make path-first retrieval the normal pattern.

### Deprecate/remove `collect-results`

`collect-results` should not be a primary command. Preferred hard-cutover:

- remove from docs and Pi tools;
- implement `tango result --unread`;
- optionally keep a short-lived internal alias only if needed during development, but given current compatibility preference, removal is acceptable.

### Pi tools

Replace `tango_collect_results` with result-centric tools:

- `tango_result(name/runId/runDir, peek?)`
- `tango_result_unread(rootSessionId?, workstreamId?, peek?)`
- or one `tango_result` tool with parameters:

```ts
{
  name?: string;
  runId?: string;
  runDir?: string;
  inboxId?: string;
  unread?: boolean;
  peek?: boolean;
  cwd?: string;
}
```

Renderer behavior:

- Compact view previews title/agent/result state.
- Expanded view can show full result or a scrollable/Markdown-rendered full result depending on Pi capabilities.
- Tool details retain full content for the model when the action is result retrieval.

## Wait/follow semantics cleanup

### Smell

`follow` is overloaded:

- it waits;
- it has result-ish behavior;
- `terminal` has been semantically loose;
- it does not handle target sets (`any`, `all`, descendants, inbox, etc.) cleanly.

### Desired model

Add a first-class wait command:

```bash
tango wait <targets...> --until <condition> --mode any|all
```

`wait` is about synchronization. `result` is about retrieving result content. `inbox` is about attention items.

### Conditions

Recommended initial conditions:

| Condition | Meaning |
| --- | --- |
| `terminal` | `done`, `error`, or `stopped`; explicitly excludes `blocked` |
| `success` | `done` with a valid ready result or accepted summary-only completion |
| `result-ready` | result is safe/readable |
| `attention` | unresolved inbox-worthy state: blocked, error, stalled, offline, ask, urgent update |
| `blocked` | blocked only |
| `error` | error only |
| `settled` | terminal or attention-required; useful for “stop actively waiting for progress” |
| `inbox` | unresolved inbox item exists for target/scope |

Avoid ambiguous condition names like `inactive` until the semantics are proven.

### Modes

```bash
--mode all   # every selected target must satisfy condition
--mode any   # return when at least one selected target satisfies condition
```

Default:

- explicit multiple targets: default `all`;
- target set selectors with attention-like conditions: default may still be `any` only if explicit in docs; safer default is `all` and require `--mode any`.

### Target selection

Explicit targets:

```bash
tango wait alpha beta --until terminal --mode all
tango wait --run-id run_a --run-id run_b --until result-ready --mode any
```

Target sets:

```bash
tango wait --children-of <run-id|run-dir> --until result-ready --mode all
tango wait --descendants-of <run-id|run-dir> --until attention --mode any
tango wait --workstream-id <id> --until settled --mode all
tango wait --root-session-id <id> --until inbox --mode any
```

Filters, likely later:

```bash
--direct            # direct children only
--recursive         # descendants
--role lead,worker
--status running,blocked
--local             # current Pi/tool local watched set, if exposed through a scope file
```

### JSON return shape

```json
{
  "ok": true,
  "schemaVersion": 1,
  "condition": "result-ready",
  "mode": "any",
  "matched": [
    { "runId": "run_...", "name": "agent", "status": "done", "resultReady": true }
  ],
  "pending": [],
  "failed": [],
  "timedOut": false
}
```

Timeout:

```json
{
  "ok": false,
  "timeout": true,
  "condition": "result-ready",
  "mode": "all",
  "matched": [...],
  "pending": [...],
  "failed": [...]
}
```

### What happens to `follow`

Preferred:

- Keep `follow` only as a single-target convenience during transition.
- Internally implement it through `wait`.
- Fix `terminal` immediately to exclude `blocked`.
- Docs should steer agents/humans toward `wait` for synchronization patterns.

Possible aliases:

```bash
tango follow <target> --until result-resolved
# maps to:
tango wait <target> --until result-ready --mode all
```

But `result-resolved` should likely be renamed/removed once `result-ready` exists.

## Board/tree projection cleanup

### Direct-child default

The root session UI should not display the full recursive tree inline. It should show direct delegated agents only.

Direct child row:

```text
⠹ ↔ L retrieval-plan   running  2m14s  managing 4: 2 active · 1 blocked · 1 ready
```

Non-managing child row:

```text
✓ → scout repo-map      result ready
```

No `managing 0` label.

### Delegation-capable label

Show `L` or `(L)` for agents capable of delegation.

Initial rule:

- `lead` role gets `L`.
- Future roles may get `L` if role policy explicitly grants delegation.
- Do not infer from current child count alone.

Compact options:

```text
lead(L) retrieval-plan
L retrieval-plan
↔ L retrieval-plan
```

Recommended compact row format:

```text
<status-icon> <mode-marker> <delegate-marker?> <role/name> <status> <runtime> <summary> <descendant-aggregate?>
```

Mode markers:

| Mode | Marker | Meaning |
| --- | --- | --- |
| interactive | `↔` | can receive messages / long-lived |
| oneshot | `→` | fire-and-complete |

Expanded overlays should spell these out as `interactive` and `oneshot`.

### Descendant aggregates

For each direct child, compute descendants across its subtree:

```ts
interface DescendantAggregate {
  total: number;
  active: number;
  blocked: number;
  stalled: number;
  offline: number;
  resultReady: number;
  error: number;
  done: number;
}
```

Render only when `total > 0`:

```text
managing 4: 2 active · 1 blocked · 1 ready
```

Rules:

- Keep aggregate short; prioritize unhealthy/actionable states.
- If space is constrained, show `managing 4 · 1 blocked`.
- Full breakdown lives in `/tango-status` overlay.

### Core projection helper

Do not make Pi extension compute tree ownership ad hoc long term. Add a core projection helper consumed by CLI/server/Pi:

```ts
buildAgentTreeProjection(scope): {
  direct: AgentTreeRow[];
  byParent: Record<runId, AgentTreeRow[]>;
  counts: ...;
}
```

Board API can expose:

```json
{
  "direct": [...],
  "descendantAggregates": { "run_...": { ... } }
}
```

The Pi widget consumes this projection; the dashboard can also reuse it.

## Pi live TUI integration

This cleanup must preserve and build on the TUI plan in `docs/specs/tango-pi-live-tui/design.md`.

### Placement

Persistent compact widget above the editor:

```text
◆ Tango  3 active · 1 blocked · 2 ready
  ⠹ ↔ L retrieval-plan   running  2m14s  managing 4: 2 active · 1 blocked
  ⚠ ↔ worker inbox-cutover blocked  needs input
  ✓ → scout repo-map       result ready
```

Footer stays compact:

```text
Tango: 3 active · 1 blocked · 2 unread
```

Full tree/details in overlay:

```text
/tango-status
```

### Agent lifetime in widget

Oneshot policy:

- show while running;
- show while result/error/inbox item is unread/actionable;
- after handled successful completion, keep for `terminalHandledGraceMs = 2 minutes`;
- stopped unactionable oneshots disappear after `terminalUnactionableGraceMs = 60 seconds`;
- older terminal oneshots remain in overlay recent/history, not compact widget.

Interactive policy:

- show while running/blocked/stalled/offline;
- after terminal handled completion, same short grace period;
- if still alive and messageable, keep visible.

### Pi tools vs CLI

Pi should use tools, not raw shell, for normal coordination:

- `tango_start`
- `tango_wait` (new)
- `tango_result` with unread/inbox modes
- `tango_board`
- `tango_inbox`
- `tango_message`

This allows:

- custom cards;
- live widget updates;
- safe rendering;
- stable structured arguments;
- fewer shell quoting/targeting mistakes.

Raw CLI remains clean for non-Pi harnesses.

### Wake-up cards

Pi inbox wake-ups are custom `tango-message` UI messages backed by structured details. They should not display raw protocol envelopes.

Agent-directed tmux/stdin messages may use:

```text
---BEGIN TANGO MESSAGE---
...
---END TANGO MESSAGE---
```

This is for harness/agent parsing, not default Pi visual presentation.

## Inbox/attention cleanup

### Desired vocabulary

User-facing concepts:

- `board`: what is happening;
- `inbox`: what needs attention/action;
- `message`: communication record;
- `result`: produced deliverable/content;
- `wait`: synchronization.

Avoid user-facing reliance on:

- subscriptions;
- legacy attention records;
- result file paths as primary UX;
- activity log scraping.

### Remaining cleanup

- Remove or demote `attention.ts` if inbox fully replaces it.
- Ensure blocked/error/stalled/offline create inbox items through one projection/reconciler path.
- Reads should ideally not be surprising mutators; if inbox reads sync derived items, document or split `--sync` later.

## Implementation plan

### Phase 1 — Spec and command shape

- Finalize this design.
- Update existing TUI design with direct-child + `L` label + mode marker + oneshot retention rules.
- Decide hard cutover vs aliases for `collect-results` and `follow`.

### Phase 2 — Result command unification

- Add `tango result --unread`.
- Add `tango result --inbox <id>`.
- Add `--peek`.
- Remove/demote `collect-results` from docs and Pi tools.
- Ensure full result is default and never Tango-truncated.
- Update Pi `tango_result` tool parameters/rendering.

### Phase 3 — Wait command

- Add `tango wait` CLI.
- Implement explicit conditions and `any|all` modes.
- Add target set selectors for explicit targets and direct children.
- Fix `terminal` semantics to exclude `blocked`.
- Rebase/deemphasize `follow` on top of wait.

### Phase 4 — Tree projection

- Add core direct-child/descendant aggregate projection.
- Expose through board API/CLI JSON.
- Include delegation-capable marker based on role policy.
- Include mode marker data (`interactive`/`oneshot`).

### Phase 5 — Pi TUI widget and tools

- Implement live widget above editor using core projection.
- Show direct children only; aggregates under owners.
- Add `L` marker and mode marker.
- Add oneshot retention behavior.
- Add/replace Pi tools: `tango_wait`, updated `tango_result`; remove `tango_collect_results` if hard cutover.

### Phase 6 — Overlay

- Implement `/tango-status` read-only overlay.
- Add drill-down for descendants.
- Add safe actions after read-only view is stable.

## Validation checklist

### Raw CLI

- `tango result <target>` prints full result.
- `tango result --unread` prints all unread full results and marks handled.
- `tango result --inbox <id>` prints the matching full result and marks handled.
- `--peek` does not mark handled.
- `tango wait a b --until terminal --mode all` excludes blocked from terminal.
- `tango wait --children-of <run> --until attention --mode any` returns blocked/error/stalled/offline child promptly.
- Timeout JSON includes matched and pending.

### Pi tools/TUI

- Pi uses `tango_result` / `tango_wait`, not Bash, for normal coordination.
- Live widget shows direct children only.
- Lead/delegation-capable child shows `L`.
- Interactive/oneshot marker is visible but compact.
- Descendant aggregate appears only when count > 0.
- Oneshot disappears from compact widget after handled grace period.
- Unrelated Claude Code Tango runs do not appear in local Pi widget/wake-up cards.
- Inbox wake-up card is rendered as a styled `tango-message`, not raw envelope text.

## Open questions

1. Hard remove `collect-results` immediately, or keep a hidden alias for one release?
2. Should `tango wait` default `--mode` be `all` universally?
3. Should `success` require result deliverable readiness for all roles, or respect `summary-only`/`noResultRequired` metadata?
4. Should delegation-capable marker be strictly role-based (`lead`) or policy-based from role metadata?
5. Should direct-child projection be scoped by current Pi session local watch set, root session, current run, or explicit user setting by default?

## Recommended decisions

- Hard cut over docs and Pi tools from `collect-results` to `tango result --unread`.
- Keep `collect-results` only if needed internally during implementation, not as a promoted user-facing command.
- Add `tango wait`; stop expanding `follow`.
- Fix `terminal` semantics immediately.
- Use `L` for delegation-capable agents; omit descendant label when count is zero.
- Preserve TUI compact widget above editor as the primary Pi session status surface.
