# Loom v1 Canonical Contracts

Status: draft contract  
Date: 2026-04-24

This document defines the v1 durable file formats, IDs, command-facing data contracts, and SQLite projection shape for Loom. The goal is to make implementation choices explicit while keeping v1 shallow.

## Contract Principles

- Markdown node files are the durable source of truth for graph content.
- `loom.json` is the durable source of truth for Loom instance identity and workspace declarations.
- `events.jsonl` is an audit log, not a replay engine in v1.
- SQLite is split into rebuildable projection state and canonical runtime coordination state.
- `index.sqlite` is rebuildable; `runtime/runtime.sqlite` is canonical for inboxes, participants, subscriptions, and delivery bookkeeping in v1.
- Agents should interact with nodes, context, inbox items, and results, not storage internals.

## IDs and References

```ts
type LoomId = `lm_${string}`;        // e.g. lm_7k3f9x2a
type NodeId = `N-${string}`;         // e.g. N-0001
type InboxItemId = `M-${string}`;    // e.g. M-0001
type AgentId = string;              // e.g. feature-lead-a

type LoomRef = LoomId | string;      // ID or registered alias
type NodeRef = NodeId | `${LoomRef}:${NodeId}`;
```

Node IDs are stable local IDs and do not encode hierarchy. Cross-Loom references use qualified refs such as `lm_7k3f9x2a:N-0042` or `feature-x:N-0042`.

## Instance Layout

```txt
<loom-root>/
  .loom/
    loom.json
    events.jsonl
    index.sqlite
    nodes/
      N-0001-title-slug.md
    artifacts/
      N-0001/
        ...
    runtime/
      runtime.sqlite
      loom.lock
      context/
        <agent-id>.json
```

`runtime/` is for generated files. Its commit/ignore policy is user/project policy, not hardcoded by Loom.

## `.loom/loom.json`

`loom.json` is the canonical instance metadata file.

```ts
interface LoomConfigV1 {
  schemaVersion: 1;
  id: LoomId;
  name?: string;             // local alias suggestion, not globally authoritative
  title: string;
  root: string;              // usually ".", relative to directory containing .loom
  workspaces?: WorkspaceRef[];
  created_at?: string;       // ISO 8601
  updated_at?: string;       // ISO 8601
}

interface WorkspaceRef {
  id: string;                // e.g. "repo"
  path: string;              // relative to loom root, or absolute if necessary
  kind?: "git" | "dir" | string;
}
```

Example:

```json
{
  "schemaVersion": 1,
  "id": "lm_7k3f9x2a",
  "name": "feature-x",
  "title": "Feature X Design",
  "root": ".",
  "workspaces": [
    { "id": "repo", "path": "../../..", "kind": "git" }
  ]
}
```

## Node Markdown Files

Node files live in `.loom/nodes/` and are named:

```txt
<node-id>-<slug>.md
```

The `id` frontmatter field, not the filename, is canonical.

### Node Frontmatter

```ts
type NodeKind =
  | "proposal"
  | "question"
  | "research"
  | "design"
  | "variant"
  | "critique"
  | "decision"
  | "plan"
  | "task"
  | "result"
  | string;

type NodeState = "open" | "active" | "resolved" | "archived";

type Resolution =
  | "answered"
  | "chosen"
  | "rejected"
  | "implemented"
  | "validated"
  | "invalidated"
  | "inconclusive"
  | "deferred"
  | "superseded"
  | string;

type EdgeType =
  | "variant_of"
  | "depends_on"
  | "references"
  | "critiques"
  | "chooses"
  | "supersedes"
  | string;

interface NodeFrontmatterV1 {
  id: NodeId;
  title: string;
  kind: NodeKind;
  state: NodeState;
  parent?: NodeId | null;
  summary?: string;
  tags?: string[];
  edges?: NodeEdge[];
  artifacts?: NodeArtifact[];
  references?: NodeReference[];
  resolution?: Resolution;
  created_by?: AgentId | "human" | string;
  updated_by?: AgentId | "human" | string;
  created_at: string;        // ISO 8601
  updated_at: string;        // ISO 8601
}

interface NodeEdge {
  type: EdgeType;
  to: NodeRef;
  label?: string;
}

interface NodeArtifact {
  path: string;              // usually .loom/artifacts/<node-id>/<file>
  label?: string;
  kind?: string;             // diagram, evidence, note, report, etc.
}

interface NodeReference {
  workspace?: string;        // preferred for workspace files
  path: string;              // workspace-relative if workspace is set
  label?: string;
  kind?: string;             // source, spec, doc, test, etc.
}
```

### Node Markdown Body

V1 does not require a strict heading schema. Commands should preserve unknown content. Generated nodes should prefer this shape:

```md
---
id: N-0042
title: Filesystem locking strategy
kind: design
state: active
parent: N-0021
summary: Explore how Loom should handle concurrent local writes.
tags: [storage, concurrency]
edges:
  - type: depends_on
    to: N-0039
references:
  - workspace: repo
    path: packages/tango/src/start.ts
    label: Tango start implementation
    kind: source
created_by: human
created_at: 2026-04-24T12:00:00Z
updated_at: 2026-04-24T12:30:00Z
---

# Summary

Explore how Loom should handle concurrent local writes.

# Context

...

# Analysis

...

# Result

Pending.
```

## Artifacts and References

Artifacts are node-owned files copied or created under:

```txt
.loom/artifacts/<node-id>/
```

References point to external files and should not be copied by default. Workspace-relative references are preferred.

Commands should update node frontmatter and the SQLite projection:

```bash
loom artifact add N-0042 ./diagram.mmd --copy --label "Architecture diagram"
loom reference add N-0042 --workspace repo packages/tango/src/start.ts --label "Tango start"
```

## Event Log

`.loom/events.jsonl` stores one JSON object per line. V1 treats this as audit history.

```ts
interface LoomEventBase {
  event_id: string;
  type: string;
  time: string;              // ISO 8601
  actor?: AgentId | "human" | string;
}

type LoomEventV1 =
  | (LoomEventBase & { type: "node.created"; node_id: NodeId; title: string; kind: NodeKind })
  | (LoomEventBase & { type: "node.updated"; node_id: NodeId })
  | (LoomEventBase & { type: "node.resolved"; node_id: NodeId; resolution?: Resolution })
  | (LoomEventBase & { type: "node.archived"; node_id: NodeId })
  | (LoomEventBase & { type: "node.decomposed"; source: NodeId; children: NodeId[] })
  | (LoomEventBase & { type: "node.branched"; source: NodeId; variants: NodeId[] })
  | (LoomEventBase & { type: "edge.added"; from: NodeId; to: NodeRef; edge_type: EdgeType })
  | (LoomEventBase & { type: "inbox.sent"; item_id: InboxItemId; recipient_agent_id: AgentId; node_id?: NodeId })
  | (LoomEventBase & { type: "inbox.updated"; item_id: InboxItemId; state: InboxState });
```

Unknown event types must be preserved by log readers.

## Inbox Contract

Inbox state is canonical in SQLite for v1. Inbox items are agent-facing. Delivery fields are internal diagnostics.

```ts
type InboxType =
  | "assignment"
  | "question"
  | "review_request"
  | "decision_request"
  | "context_update"
  | "subscription_event"
  | "interrupt"
  | "handoff"
  | string;

type InboxState = "open" | "accepted" | "done" | "cancelled";

type DeliveryState = "none" | "delivered" | "failed" | "skipped_offline" | "skipped_policy";

type Priority = "low" | "normal" | "high" | "urgent";

interface InboxItemV1 {
  id: InboxItemId;
  loom_id: LoomId;
  recipient_agent_id: AgentId;
  node_id?: NodeId;
  type: InboxType;
  priority: Priority;
  state: InboxState;
  payload: {
    subject?: string;
    message?: string;
    expected_action?: string;
    sender_agent_id?: AgentId;
    requester_agent_id?: AgentId;
    parent_agent_id?: AgentId;
    relation?: "parent_to_child" | "child_to_parent" | "peer" | "subscription" | string;
    summary?: string;
    [key: string]: unknown;
  };
  delivery_state: DeliveryState;
  delivery_attempts: number;
  delivery_error?: string;
  created_at: string;
  updated_at: string;
}
```

### Delivery Rendering Defaults

V1 delivery rendering is internal policy, not a schema burden for agents:

- parent/lead -> child/worker: `request` rendering;
- child/worker -> parent/lead: `update` rendering;
- peer -> peer: `request` rendering;
- subscription: `update` or `digest` rendering.

Every delivered message should include the inbox item ID and fetch command.

## Agent Context File

Generated context files live under `.loom/runtime/context/` or a temp directory and are passed via `LOOM_CONTEXT`.

```ts
interface LoomAgentContextV1 {
  agentId: AgentId;
  default: LoomId;
  looms: Array<{
    id: LoomId;
    alias?: string;
    rootPath: string;
    loomPath: string;
  }>;
}
```

Environment variables:

```txt
LOOM_AGENT_ID=<agent-id>
LOOM_DEFAULT=<loom-id-or-alias>
LOOM_CONTEXT=<path-to-context-json>
```

## Registry Contract

The global registry is per-machine and lives at:

```txt
~/.loom/registry.sqlite
```

Minimal v1 tables:

```sql
registry_looms(
  id text primary key,
  alias text unique,
  title text,
  root_path text not null,
  loom_path text not null,
  last_seen_at text
);

registry_agent_defaults(
  agent_id text primary key,
  loom_id text not null
);
```

## SQLite Contracts

V1 uses two SQLite databases:

```txt
.loom/index.sqlite
.loom/runtime/runtime.sqlite
```

`index.sqlite` is rebuildable projection/search state. `runtime/runtime.sqlite` is canonical runtime coordination state and must not be deleted by `loom index rebuild`.

### Projection Database: `index.sqlite`

Projection tables:

```sql
nodes(
  id text primary key,
  slug text,
  title text not null,
  kind text not null,
  state text not null,
  parent_id text,
  summary text,
  body text,
  path text not null,
  created_at text,
  updated_at text
);

edges(
  from_loom_id text,
  from_node_id text not null,
  to_loom_id text,
  to_node_id text not null,
  type text not null,
  label text,
  created_at text
);

chunks(
  id text primary key,
  node_id text not null,
  heading_path text,
  text text not null,
  start_line integer,
  end_line integer
);

node_files(
  node_id text not null,
  role text not null,        -- artifact|reference
  workspace text,
  path text not null,
  label text,
  kind text
);

node_closure(
  ancestor_id text not null,
  descendant_id text not null,
  depth integer not null
);
```

### Runtime Database: `runtime/runtime.sqlite`

Runtime/canonical coordination tables:

```sql
inbox_items(
  id text primary key,
  recipient_agent_id text not null,
  node_id text,
  type text not null,
  priority text not null,
  state text not null,
  payload_json text,
  delivery_state text not null,
  delivery_attempts integer not null default 0,
  delivery_error text,
  created_at text not null,
  updated_at text
);

participants(
  agent_id text primary key,
  role text,
  joined_at text,
  last_seen_at text
);

subscriptions(
  agent_id text not null,
  scope_json text not null,
  created_at text not null
);
```

FTS tables may be implementation-specific, but v1 should expose BM25 search behavior over node bodies and chunks.

## Command Output Contract

Commands should support human output by default and JSON output via `--json`.

JSON success envelope:

```ts
interface JsonSuccess<T> {
  ok: true;
  data: T;
}
```

JSON error envelope:

```ts
interface JsonError {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
```

Agents and wrappers should prefer `--json` when parsing.
