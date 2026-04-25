# Loom v1 Operations Contract

Status: draft contract  
Date: 2026-04-24

This document defines how Loom v1 commands safely mutate durable files, projections, runtime state, and notifications. `contracts.md` defines data shapes; this file defines command behavior and operational invariants.

## Core Operational Principles

- CWD is not identity; commands must resolve a Loom instance explicitly or through context/registry/discovery.
- Markdown node files are canonical for graph content.
- `index.sqlite` is rebuildable projection/search state.
- `runtime/runtime.sqlite` is canonical runtime coordination state for inboxes, participants, subscriptions, and delivery bookkeeping.
- State-changing commands must go through Loom so they can lock, update files, append events, update projections, and route notifications.
- Agents should not manage locks, indexes, registries, delivery, or migrations during normal work.

## SQLite Files

V1 uses two local SQLite databases:

```txt
.loom/index.sqlite
.loom/runtime/runtime.sqlite
```

### `index.sqlite`

Rebuildable from Markdown node files and config.

Contains:

- `nodes`
- `edges`
- `chunks`
- FTS tables
- `node_files`
- `node_closure`

`loom index rebuild` may delete and recreate `index.sqlite`.

### `runtime/runtime.sqlite`

Canonical runtime coordination state.

Contains:

- `inbox_items`
- `participants`
- `subscriptions`
- local counters if implementation chooses not to scan/derive IDs
- migration metadata

`loom index rebuild` must not delete or recreate `runtime/runtime.sqlite`.

## Mutation Transaction Pattern

Every state-changing command should follow this pattern:

```txt
1. resolve Loom instance;
2. acquire Loom instance mutation lock;
3. ensure/migrate SQLite schemas;
4. read current durable state;
5. apply Markdown/config/runtime SQLite mutation;
6. append event to events.jsonl;
7. update index.sqlite projection if graph content changed;
8. commit SQLite transaction(s) and flush durable files;
9. release mutation lock;
10. attempt best-effort notification delivery after durable commit.
```

Delivery happens after durable state is committed. Failed delivery must not roll back graph or inbox changes.

## Mutation Lock

V1 should use one instance-wide mutation lock:

```txt
.loom/runtime/loom.lock
```

Recommended implementation:

- use an atomic lock directory or platform file lock;
- record owner PID, command, hostname, and timestamp in lock metadata when possible;
- short default timeout, e.g. 10 seconds;
- on timeout, fail with `LOCK_TIMEOUT` and explain which command appears to hold the lock;
- stale lock removal is operator/doctor behavior, not normal agent behavior.

All commands that write `.loom/loom.json`, `.loom/nodes`, `.loom/artifacts`, `.loom/events.jsonl`, `index.sqlite`, or `runtime/runtime.sqlite` must acquire the mutation lock.

Read-only commands do not require the mutation lock, but may open SQLite read-only when practical.

## Atomic File Writes

Commands that write durable files should use atomic replacement:

```txt
1. write temp file in same directory;
2. flush/fsync when practical;
3. rename temp file over final path;
4. clean up temp file on failure when possible.
```

Example:

```txt
.loom/nodes/N-0042-title.md.tmp-<pid>
rename -> .loom/nodes/N-0042-title.md
```

Appending `events.jsonl` should be done while holding the mutation lock. Each event is one JSON object followed by a newline.

## ID Allocation

V1 IDs are stable, local, monotonic-looking IDs. They do not encode hierarchy.

```txt
Nodes:       N-0001, N-0002, ...
Inbox items: M-0001, M-0002, ...
```

Recommended v1 behavior:

- allocate node IDs under the mutation lock by scanning existing node IDs and choosing max + 1;
- allocate inbox item IDs under the mutation lock by scanning `runtime.sqlite` inbox IDs and choosing max + 1, or by a runtime counter table;
- preserve 4-digit padding until the number exceeds it (`N-9999`, then `N-10000`).

If an implementation later introduces counters, counters must be updated under the same mutation lock.

## Node Mutation Rules

Commands may update known frontmatter fields and command-owned body sections. Unknown body content must be preserved.

Generated nodes should use optional conventional sections:

```md
# Summary
# Context
# Analysis
# Result
# Notes
```

V1 mutation conventions:

- `loom create` writes a new Markdown node with frontmatter and optional starter sections.
- `loom decompose` creates child nodes whose `parent` is the source node.
- `loom branch` creates variant nodes and `variant_of` edges to the source node.
- `loom link` updates frontmatter `edges` on the source node.
- `loom decide` creates a decision node and a `chooses` edge to the chosen node.
- `loom resolve` updates `state`, `resolution`, `summary`/result metadata, and appends or updates a command-owned result/notes section.
- `loom note` appends to `# Notes` or a command-owned notes block.

Commands should not rewrite arbitrary prose outside frontmatter and command-owned sections.

## Manual Edits and Sync

Manual Markdown edits are allowed.

V1 behavior:

- Loom commands read Markdown node files as source of truth for graph content.
- Manual edits do not append events or route notifications.
- `loom index rebuild` repairs projection/search after manual edits.
- Invalid frontmatter should produce a parse error identifying the node file.
- If a node file is missing but exists in `index.sqlite`, the projection is stale; read commands should prefer Markdown truth and suggest `loom index rebuild`.

Future `loom sync` may detect manual changes and emit events, but this is out of scope for v1.

## CLI Global Flags

Global flags should work before or after subcommands when feasible:

```bash
loom -L feature-x show N-0042
loom show N-0042 -L feature-x
```

Core global flags:

```txt
-L, --loom <id-or-alias>   Select Loom instance
--json                     Emit stable JSON envelope
--cwd <path>               Override discovery base for scripts/tests
--help                     Command help
--version                  Version
```

Agents and wrappers should use `--json` when parsing.

## Loom Resolution Rules

Resolution order:

1. explicit `-L/--loom`;
2. qualified node ref, e.g. `feature-x:N-0042`;
3. `LOOM_CONTEXT`;
4. `LOOM_DEFAULT`;
5. registry agent default/subscriptions where command accepts agent identity;
6. upward CWD discovery;
7. error if missing or ambiguous.

Rules:

- explicit `-L/--loom` wins over CWD discovery and environment defaults;
- qualified refs use their qualifier;
- stable Loom IDs are preferred in generated prompts/messages;
- if aliases conflict, fail with `AMBIGUOUS_LOOM` and ask for a stable `lm_...` ID;
- CWD discovery must never silently override explicit flags or env context.

## Command JSON Envelope

All commands that support `--json` return one of:

```ts
interface JsonSuccess<T> {
  ok: true;
  data: T;
}

interface JsonError {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
```

## Common JSON Payloads

```ts
interface NodeSummary {
  id: NodeId;
  title: string;
  kind: string;
  state: string;
  parent?: NodeId | null;
  summary?: string;
  path: string;
}

interface NodeResult {
  node: NodeSummary;
  event_id?: string;
}

interface SearchHit {
  node: NodeSummary;
  score: number;
  snippet?: string;
  heading_path?: string;
}

interface InboxSummary {
  id: InboxItemId;
  recipient_agent_id: AgentId;
  node_id?: NodeId;
  type: string;
  priority: string;
  state: string;
  subject?: string;
  created_at: string;
}
```

## Exit Codes

Recommended v1 exit codes:

```txt
0  success
1  general error
2  invalid CLI usage
3  not found
4  conflict/ambiguous resolution
5  lock timeout
6  validation/parse error
7  external transport failure after durable state committed
```

If `--json` is set, command failures should still emit the JSON error envelope.

## Error Codes

Initial stable error codes:

```txt
LOOM_NOT_FOUND
NODE_NOT_FOUND
INBOX_ITEM_NOT_FOUND
AGENT_NOT_FOUND
INVALID_REF
INVALID_ARGUMENT
INVALID_FRONTMATTER
AMBIGUOUS_LOOM
REGISTRY_CONFLICT
LOCK_TIMEOUT
INDEX_STALE
SCHEMA_TOO_NEW
MIGRATION_FAILED
DELIVERY_FAILED
TANGO_UNAVAILABLE
TRANSPORT_UNAVAILABLE
```

Transport failures after durable commit should be reported as warnings in human output when appropriate, and as `delivery_state=failed` in runtime state. They should not make the graph mutation disappear.

## Schema and Migration Contract

Both SQLite databases should use `PRAGMA user_version`.

V1 version:

```txt
user_version = 1
```

On startup, commands should:

- create missing schemas;
- migrate older known schemas;
- fail with `SCHEMA_TOO_NEW` if the database version is newer than the CLI supports;
- never drop runtime canonical tables during `loom index rebuild`.

## Git/Ignore Policy

Loom should not enforce repository ignore/commit policy.

Recommended defaults to document for users:

Usually commit:

```txt
.loom/loom.json
.loom/nodes/
.loom/artifacts/        # project policy; commit if artifacts are durable evidence
.loom/events.jsonl      # project policy; useful audit trail but may be noisy
```

Usually ignore:

```txt
.loom/index.sqlite
.loom/runtime/
```

Loom may offer a helper to print suggested `.gitignore` entries, but should not write them unless explicitly requested.

## Agent Burden Boundary

Normal agents should know how to:

- inspect inbox items;
- fetch node context;
- search;
- add notes/results;
- mark inbox items done.

Normal agents should not be expected to:

- clear stale locks;
- rebuild indexes except when explicitly asked;
- repair registries;
- inspect SQLite;
- retry delivery;
- edit raw event logs;
- manually coordinate transports.
