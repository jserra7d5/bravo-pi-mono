## Tango Agent Orchestration

Tango lets you delegate bounded work to child agents while keeping all agent processes observable through tmux and the `tango` CLI.

Delegate only when it reduces complexity or enables useful parallelism. Prefer small, named child agents with clear tasks and expected outputs.

Common roles:

- `scout`: GPT-backed read-only discovery and evidence gathering.
- `planner`: implementation/design/sequencing plans.
- `reviewer`: read-only review, audit, and readiness checks.
- `worker`: nontrivial implementation work.
- `fast-worker`: small tactical implementation work.
- `lead`: bounded workstream coordination and result synthesis.
- `generalist`: mixed research/planning/review/small implementation for ambiguous bounded tasks.

### Runtime identity and lineage

Tango v1 tracks stable runtime identity across runs and parent/child trees:

- `runId`: a stable identity for one agent run.
- `runDir`: the agent's working directory.
- `parentRunId` / `parentRunDir`: the exact tree parent when one agent starts another.
- `rootSessionId`: present when the top-level session (Pi root, CLI, or dashboard) established it.
- `workstreamId`: present when the environment or context established it; legacy/direct starts may lack it.

Child agents inherit the parent's root session and workstream when the environment provides them. This lets commands target agents by stable IDs instead of depending on the current working directory.

### Targeting guidance

Prefer stable targeting over name-only or cwd-dependent targeting:

- Use `--run-id <id>` when you know the run ID.
- Use `--run-dir <path>` when you know the run directory.
- Name-only targeting resolves through lineage first: children, then descendants, then same root session/workstream. Cwd and global fallback occur only when no lineage context exists.

Do **not** `cd` into a child agent's cwd to run `tango activity`, `tango message`, `tango result`, `tango stop`, or `tango follow --until terminal`. Tango resolves agents by lineage and stable IDs from any directory.

### Server, dashboard, and artifacts

Tango can run an optional local server:

- `tango server` starts a host-native HTTP+SSE control plane.
- The server provides event streaming, a root-session-oriented web dashboard, and artifact hosting.
- The CLI and Pi extension do not require the server; some features like dashboard/API visibility and tokenized artifact URLs are available when the server is running.
- Use `tango message` for agent-to-agent messaging; the CLI remains the primary delivery mechanism.
- Artifacts are published with `tango artifact publish` and served at tokenized URLs; only registered artifacts are exposed.

### Attention and delivery semantics

Status transitions emit Tango events. Attention visibility is currently status-derived in the dashboard; durable attention records and inbox projection are planned. Blocked, error, and `needs` items typically remain visible until resolved or dismissed.

### Claude Code harness limitations

The Claude Code harness does not support Pi persistent extensions. Claude-harness agents must use the Tango CLI (and the server when available) for orchestration, messaging, and status. They cannot rely on Pi tools or custom message renderers.

Delegation guidelines:

1. Give each child a specific name, role, scope, and deliverable.
2. Do not spawn agents recursively unless it clearly helps.
3. Inspect child output before relying on it.
4. Prefer one or two focused children over many broad children.
5. When children finish, synthesize their findings and cite which child produced which result.
