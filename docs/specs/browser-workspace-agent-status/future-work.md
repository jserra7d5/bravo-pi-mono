# Future Work Handoff

## Current checkpoint

The first vertical slice is implemented and deployed:

- the lead Pi session's async-subagents extension owns the canonical count of child runs whose reconciled state is exactly `running`;
- it reports over the owner-restricted browser-workspace Unix socket;
- browser-workspace validates the exact `bw-*` tmux session and holds a sequenced, TTL-bound in-memory lease;
- each workspace card quietly displays only a positive running-child count;
- browser-workspace does not import async-subagents or inspect its files;
- tmux remains the durable terminal substrate and the supervised browser-workspace process is the control-plane host.

The current workspace-card presentation is functional, not a settled design. Do not accumulate more ad hoc badges in the existing card before defining a coherent compact status layout.

## Next product slice: lead activity

Add lead-agent semantic activity as an independent projection over the existing socket boundary. At minimum distinguish:

- `working`: the lead model/tool turn is active;
- `ready`: the lead turn ended and awaits user input;
- `needs_attention`: an explicit lead-level question or actionable failure;
- `unavailable`: the reporter lease expired or identity cannot be established.

Do not use `done` as an inferred lead or workspace state. A ready lead can still own running subagents, background commands, or monitors.

The workspace projection must compose independent signals rather than collapse them:

```text
Lead: Ready · 2 agents running
Lead: Working
Lead: Needs attention · 1 agent running
```

Exact wording and visuals require a dedicated sidebar/card design pass.

## Later control-plane slices

1. Add explicit projections for background bash and monitor activity without treating long-lived observation as active finite work.
2. Report agent hierarchy edges (`parent session/run -> child run`) through a versioned protocol extension.
3. Map each interactive agent identity to its exact tmux-backed terminal.
4. Render a navigable ownership tree and allow click-to-open terminal selection.
5. Reuse existing async-subagent message, pause, cancel, continue, and result lifecycle controls rather than creating competing daemon semantics.
6. Add non-Pi adapters only where the CLI exposes trustworthy lifecycle hooks; do not fall back to terminal text scraping merely to claim support.

## Durable ownership rules

- The lead Pi integration owns composite semantic state.
- Each extension owns its native lifecycle interpretation.
- The browser-workspace service validates identity, maintains ephemeral leases, and projects state.
- tmux owns terminal durability.
- Existing async-subagent run files remain canonical for async-subagent recovery; browser-workspace must never watch or parse them.
- Unknown or expired evidence fails to `unavailable`/quiet, never to `idle`, `ready`, or `done`.

## Required seams for future slices

For each new projection, exercise the real producer event path through the production Unix socket, exact tmux binding, HTTP projection, and browser card/tree. Inject reporter loss and identity mismatch. Uncertain tmux inspection must preserve existing terminal iframes and status leases; only authoritative exact-session absence may mark a workspace stale.

## Known operational follow-up

The user service currently recovers correctly after forced termination, preserving tmux and leaving one owned ttyd, but graceful stop exceeded `TimeoutStopSec=15` during rollout. Investigate the shutdown wait path separately before relying on graceful restart latency; do not weaken exact ttyd ownership or tmux durability to hide the delay.
