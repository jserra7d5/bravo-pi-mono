# Product Requirements and Non-goals

## Objective

On each browser-workspace card, quietly show the number of async subagents currently executing for the lead Pi session inside that exact `bw-*` tmux workspace.

Example positive projection (exact styling is implementation-owned):

```text
My workspace                         2
```

The count is supplemental text/badge in the card's primary button. It must not compete with the workspace name or stale marker.

## Required behavior

1. A report from lead Pi workspace A can affect only card A.
2. The count is scoped to one exact lead Pi session, not every Pi process sharing a cwd or tmux server.
3. A positive count appears without selecting or attaching to the card.
4. `0` is not rendered. Unknown, expired, unavailable, and invalid reports render identically to zero.
5. A browser-workspace restart begins with no status and stays quiet until a fresh accepted report arrives.
6. A Pi/reporter crash, socket outage, or stopped heartbeat expires to quiet without persistence.
7. Existing workspace creation, attach, stale display, rename, forget, reload, and tmux durability behavior is unchanged.
8. Status transport is local networked IPC over a restrictive Unix domain socket. No async-subagent file reads are allowed in browser-workspace.

## “Currently running” decision

The first-slice count is:

```text
number of canonical rows scoped to this rootSessionId whose reconciled RunState === "running"
```

Before counting, reuse async-subagents' current canonical read/reconciliation path so a recorded `running` process known to be dead is finalized/reconciled rather than counted.

Explicit exclusions from the number:

- `created`, `queued`: not executing yet;
- `idle`: live but not currently executing;
- `waiting_for_input`, `blocked`: needs/condition state, not running;
- `paused`: intentionally stopped;
- `stalled`: not healthy forward execution;
- `completed`, `failed`, `cancelled`, `expired`: terminal;
- result-ready/unhandled state: result semantics are orthogonal to execution.

This is intentionally narrower than current `AsyncSubagentsActivityState.activeCount`, whose owner in `extensions/pi/liveWidget.ts` includes all nonterminal rows and current unhandled terminal results. Do not silently reuse that number under a “running” label.

## Acceptance criteria

- With two exact `bw-*` sessions and two lead Pi session IDs, reports crossing the identities never move counts between cards.
- A transition `running -> blocked|paused|idle|terminal` decreases the next report's count even though the child may remain visible in Pi UI.
- A result-ready terminal run does not increase the count.
- When the last report expires, the card has no badge/text; it does not say `0`, `unknown`, or `offline`.
- No code under `packages/browser-workspace` imports async-subagents or reads its run/session directories.

## Non-goals

First slice does **not** add:

- status taxonomy, blocked/result-ready badges, hierarchy/tree UI, ownership controls, messaging, cancel/pause/resume, or terminal mapping controls;
- persistence or restart recovery for status;
- browser localStorage status caching;
- async-subagent file watching/parsing in browser-workspace;
- pane output/process-command parsing as lifecycle semantics;
- arbitrary tmux discovery or a server workspace catalog;
- non-Pi reporters/adapters;
- changes to ttyd/tmux as terminal substrate;
- Herdr integration or protocol compatibility;
- synchronization across browsers/devices.

The long-term control plane may add these only through explicit protocol/schema versions and server-owned semantic projections.