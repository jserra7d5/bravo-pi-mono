# Loom v1 Design Direction

Status: exploratory draft  
Date: 2026-04-24

Related spec files:

- `contracts.md` defines the v1 durable file, SQLite, inbox, and command-output contracts.
- `operations.md` defines locking, mutation, ID allocation, resolution, migration, and error behavior.
- `agent-guide.md` defines the compact runtime-agnostic guide for Loom-aware agents.
- `testing.md` defines the v1 testing contract and required test coverage.
- `plan.md` defines the v1 implementation milestones.

## Summary

`loom` is a CLI-first recursive work graph for research, design, planning, task decomposition, decisions, and optional execution. It is intended to complement `tango`, not replace it.

Tango manages agent processes and tmux sessions. Loom manages durable graph state: nodes, edges, branches, inboxes, subscriptions, context, and agent participation.

The core idea is that work should not be forced into a linear Research → Design → Plan → Implement pipeline. A user or agent should be able to start from a high-level proposal, branch into multiple competing designs, recursively decompose any branch, attach critiques and decisions, and eventually derive implementation work from chosen paths.

Loom state is represented as human-readable Markdown files backed by SQLite for projection/search and runtime coordination. V1 uses split SQLite databases: `.loom/index.sqlite` for rebuildable projection/search, and `.loom/runtime/runtime.sqlite` for canonical runtime state such as inboxes, participants, subscriptions, and delivery bookkeeping.

## Goals

- Represent recursive research/design/planning/execution work as a durable graph.
- Keep the model generic: nodes are not necessarily implementation tasks.
- Support branching alternatives at any node.
- Support decomposition at any node.
- Support typed semantic edges between nodes.
- Support explicit decision nodes and preserved alternatives.
- Store durable content as Markdown files.
- Maintain a rebuildable SQLite index for fast traversal and search.
- Maintain separate canonical runtime SQLite state for inboxes, subscriptions, participants, and delivery bookkeeping.
- Allow agents to operate without being tightly bound to a single task.
- Allow resident agents to join or subscribe to one or more Loom instances.
- Avoid a required central daemon by routing and delivering notifications at mutation time.
- Integrate with Tango as the primary execution/runtime and message transport adapter.
- Allow Loom instances to live anywhere, independent of agent current working directory.

## Non-goals

- Do not make Loom a process runtime. Tango owns agent process/session lifecycle.
- Do not require every node to be executable.
- Do not require every agent to have an assigned task.
- Do not require a daemon for v1.
- Do not require embeddings or remote services for v1 search.
- Do not collapse branching alternatives automatically after a decision.
- Do not assume the current working directory is the Loom root.

## Core Concepts

### Loom Instance

A Loom instance is one durable graph workspace rooted at a chosen directory.

Example:

```txt
repo-a/docs/specs/feature-x/
  .loom/
    loom.json
    index.sqlite
    events.jsonl
    nodes/
      N-0001-top-level-proposal.md
    runtime/
      runtime.sqlite
      loom.lock
      context/
```

The instance has a stable ID, optional aliases, and a path registered in a per-machine global registry.

Example `loom.json`:

```json
{
  "schemaVersion": 1,
  "id": "lm_7k3f9x2a",
  "name": "feature-x",
  "title": "Feature X Design",
  "root": ".",
  "workspaces": [
    {
      "id": "repo-a",
      "path": "../../..",
      "kind": "git"
    }
  ]
}
```

The local instance identity is portable. The global registry maps that identity to an absolute local path.

### Global Registry

Loom commands must work when the caller's current working directory is not the Loom root. A per-machine registry maps Loom IDs and aliases to absolute paths.

Suggested location:

```txt
~/.loom/registry.sqlite
```

Responsibilities:

- map `lm_...` IDs to absolute local paths;
- map aliases to IDs;
- track known Loom instances;
- track agent subscriptions/default Looms;
- support repair/scan after repos move.

Example commands:

```bash
loom registry list
loom registry resolve feature-x
loom registry scan ~/work/company
loom -L feature-x tree
loom show feature-x:N-0042
```

### Node

A node is the primary unit of thought/work. It may represent a proposal, question, research thread, design variant, critique, decision, plan, implementation task, result, or custom kind.

Nodes are intentionally generic.

Example node frontmatter:

```md
---
id: N-0042
title: Filesystem locking strategy
kind: design
state: active
parent: N-0021
tags: [storage, concurrency]
edges:
  - type: supports
    to: N-0021
  - type: blocked_by
    to: N-0051
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

### Edge

Edges are typed relationships between nodes. Containment/decomposition can be represented with a primary parent plus derived `contains` relationships. Semantic links are separate.

V1 should keep first-class edge behavior small. Suggested v1 edge types:

- `variant_of`
- `depends_on`
- `references`
- `critiques`
- `chooses`
- `supersedes`

The primary `parent` field handles containment/decomposition. `contains` can be derived in the SQLite projection, and `decomposes_to` is a command semantic rather than a required stored edge.

The system should allow custom edge types, but v1 should avoid attaching special behavior to most of them.

### Decomposition vs Branching

Decomposition means splitting a node into constituent parts that collectively elaborate or complete it.

```bash
loom decompose N-0001 \
  "Storage architecture" \
  "Graph semantics" \
  "Tango integration"
```

Branching means creating alternatives.

```bash
loom branch N-0002 \
  "Markdown source of truth" \
  "SQLite source of truth" \
  "Hybrid Markdown + SQLite"
```

These are separate operations with different semantics.

### Decision Node

A decision should be an explicit node, not just a status field.

Decision nodes can evaluate variants and choose, reject, defer, or preserve alternatives.

```txt
N-0015 Decision: Choose storage architecture
  evaluates -> N-0006 Markdown source of truth
  evaluates -> N-0007 SQLite source of truth
  chooses   -> N-0009 Hybrid Markdown + SQLite
```

Default behavior should preserve alternatives unless the user explicitly rejects or archives them.

### Artifacts and References

Nodes should have a canonical way to attach node-owned artifacts and reference external files without turning every file into a graph node.

V1 distinguishes:

- `artifacts`: files owned by the Loom/node, stored under `.loom/artifacts/<node-id>/`;
- `references`: links to files outside Loom, usually source/spec files in named workspaces.

Example frontmatter:

```yaml
artifacts:
  - path: .loom/artifacts/N-0042/diagram.mmd
    label: Architecture diagram
    kind: diagram
references:
  - workspace: repo
    path: packages/tango/src/runtime/tmux.ts
    label: Tango tmux runtime
    kind: source
```

Artifacts should be copied or created into the Loom instance. References should not be copied by default.

Workspace-relative references are preferred over long relative paths. Workspaces are declared in `loom.json`:

```json
{
  "workspaces": [
    { "id": "repo", "path": "../../..", "kind": "git" }
  ]
}
```

The SQLite projection can store file metadata in a simple table:

```sql
node_files(node_id, role, workspace, path, label, kind)
```

V1 should list artifacts/references in `loom show` and `loom context`, but should not dump referenced file contents by default. Artifact content indexing and file-as-node modeling can come later.

Example commands:

```bash
loom artifact add N-0042 ./diagram.mmd --copy --label "Architecture diagram"
loom artifact list N-0042
loom reference add N-0042 --workspace repo packages/tango/src/runtime/tmux.ts --label "tmux runtime"
loom reference list N-0042
```

### Node State and Resolution

Node state should be generic enough for research/design/planning.

Initial v1 states:

- `open`
- `active`
- `resolved`
- `archived`

Future states may include `blocked`, `rejected`, and `superseded`, but v1 should avoid over-modeling lifecycle until the core graph workflow is proven.

Resolution gives more meaning than `done`:

- `answered`
- `chosen`
- `rejected`
- `implemented`
- `validated`
- `invalidated`
- `inconclusive`
- `deferred`
- `superseded`

## Storage Architecture

### Durable Content

Markdown node files are the durable, human-readable representation.

```txt
.loom/nodes/N-0001-top-level-proposal.md
.loom/nodes/N-0002-storage-architecture.md
```

These should be easy for humans and agents to inspect, diff, and commit.

### SQLite Projection

SQLite is split by responsibility.

Projection/search state is rebuildable from node files plus config:

```txt
.loom/index.sqlite
```

Runtime coordination state is canonical for v1:

```txt
.loom/runtime/runtime.sqlite
```

Draft `index.sqlite` tables:

```sql
nodes(id, slug, title, kind, state, parent_id, summary, body, path, created_at, updated_at)
edges(from_loom_id, from_node_id, to_loom_id, to_node_id, type, label, created_at)
chunks(id, node_id, heading_path, text, start_line, end_line)
node_files(node_id, role, workspace, path, label, kind)
node_closure(ancestor_id, descendant_id, depth)
```

Draft `runtime/runtime.sqlite` tables:

```sql
inbox_items(id, recipient_agent_id, node_id, type, priority, state, payload_json, delivery_state, delivery_attempts, delivery_error, created_at)
participants(agent_id, role, joined_at, last_seen_at)
subscriptions(agent_id, scope_json, created_at)

-- Future/optional if delivery becomes more complex:
-- outbox(id, inbox_item_id, recipient_agent_id, transport, state, attempts, last_error, created_at, delivered_at)
```

The projection can be rebuilt without deleting runtime inbox/subscription/participant state:

```bash
loom index rebuild -L feature-x
```

### Event Log

An append-only event log provides auditability and future replay/time-travel options.

```txt
.loom/events.jsonl
```

Example events:

```jsonl
{"type":"node.created","id":"N-0001","title":"Recursive work graph","time":"..."}
{"type":"node.branched","source":"N-0002","variants":["N-0006","N-0007"],"time":"..."}
{"type":"inbox.sent","recipient":"planner-a","node":"N-0042","time":"..."}
```

## Search and Traversal

Loom needs both structural traversal and text retrieval.

### Traversal Commands

Core traversal commands:

```bash
loom tree N-0001
loom around N-0042 --depth 2
loom ancestors N-0042
loom descendants N-0021 --depth 3
loom path N-0001 N-0042
loom links N-0042 --incoming --outgoing
loom variants N-0021
```

### Search

v1 should use SQLite FTS5/BM25 over nodes and Markdown chunks.

```bash
loom search "filesystem locking" -L feature-x
loom search "concurrent writes" --under N-0010
loom search "lock expiry" --near N-0042
```

Search should combine:

- BM25 text relevance;
- graph scope filters (`under`, `near`, `around`);
- graph distance from an anchor node;
- state/kind filters;
- penalties for archived/superseded nodes unless included explicitly.

Embeddings may be added later as optional hybrid search, but should not be required for v1.

### Context Assembly

A key feature is compact context generation for agents:

```bash
loom context N-0042 --budget 8000
loom context N-0042 --query "lock expiry" --budget 6000
```

V1 context should stay simple and include:

- the node itself;
- ancestor chain summaries;
- direct children;
- direct links;
- artifacts and references;
- optional BM25 query matches;
- relevant workspace paths from `loom.json`.

Richer context packing, graph-distance ranking, run-result synthesis, and smart token budgeting can come later.

## Agent Model

Agents are participants, not task containers.

An agent may be:

- joined to a Loom;
- subscribed to Loom notifications;
- responding to inbox items;
- working without any assigned task.

V1 should not require precise idle/active/focus/heartbeat semantics. `focus`, richer participant status, and heartbeat-driven availability can be added later.

### Agent Guide and Runtime Awareness

Loom should provide the canonical compact guide for agents:

```bash
loom agent guide
```

`loom --help` should mention this command for agents or runtimes that need a concise operating guide. This allows an agent to become Loom-aware even when it was not spawned by Loom and does not yet have a default Loom.

Tango or another runtime may inject, paste, include, or reference this guide when starting agents. Loom owns the content of the guide; the runtime owns how the guide is delivered.

A Loom-aware agent may be:

- generally aware of Loom commands but not attached to any Loom yet;
- attached to a default Loom through environment/context;
- notified about a specific Loom with explicit `-L <loom>` commands in the message;
- spawned by `loom spawn` with a bootstrap prompt and `LOOM_CONTEXT`.

### Agent Context

A Loom-attached agent has a Loom context:

- agent ID;
- attached Loom IDs;
- default Loom ID;
- resolved paths for those Looms.

Spawned agents should inherit Loom context by default, usually narrowed to the parent's default Loom.

Recommended environment/context:

```txt
LOOM_AGENT_ID=feature-lead-a
LOOM_DEFAULT=lm_7k3f9x2a
LOOM_CONTEXT=/path/to/generated/loom-context.json
```

Example context file:

```json
{
  "agentId": "feature-lead-a",
  "default": "lm_7k3f9x2a",
  "looms": [
    {
      "id": "lm_7k3f9x2a",
      "alias": "feature-x",
      "rootPath": "/home/joe/work/company/repo-a/docs/specs/feature-x",
      "loomPath": "/home/joe/work/company/repo-a/docs/specs/feature-x/.loom"
    }
  ]
}
```

Resolution order for commands:

1. explicit `-L/--loom` flag or qualified ref like `feature-x:N-0042`;
2. `LOOM_CONTEXT`;
3. `LOOM_DEFAULT` / `LOOM_REFS`;
4. registry agent subscriptions/defaults;
5. upward CWD discovery;
6. error if ambiguous.

### Joining and Subscribing

Agents may join or subscribe to Loom instances.

```bash
loom agent join planner-a -L feature-x --role planner
loom agent subscribe planner-a -L auth-redesign
loom agent default planner-a -L feature-x
```

A team lead may subscribe to multiple Looms. A feature lead or worker will usually see only one.

Default inheritance policy for child agents:

- inherit the parent's default Loom only;
- inherit all Looms only when explicitly requested;
- allow explicit override at spawn time.

## Inbox, Events, and Notification Model

Loom should not require a daemon. Instead, Loom uses command-emitted domain events with durable inbox records and best-effort immediate delivery.

Every state-changing Loom command should follow this pattern:

```txt
1. apply the state mutation;
2. append a domain event;
3. route the event to affected agents/subscribers;
4. create durable inbox items;
5. update delivery bookkeeping fields;
6. after commit, attempt best-effort delivery through available transports.
```

This is similar in spirit to a transactional outbox pattern, but v1 keeps delivery bookkeeping on inbox items instead of requiring a separate outbox table or background relay. Delivery happens synchronously at mutation time when possible. If delivery fails, the inbox item remains durable. Delivery retry is an internal/operator concern, not a normal agent workflow.

This model assumes meaningful Loom state changes happen through Loom commands. Manual edits to Markdown files can be synchronized with `loom index rebuild` or a future `loom sync`, but they do not trigger live notifications in v1.

Inbox items are general messages, not only task assignments.

Types may include:

- `assignment`
- `question`
- `review_request`
- `decision_request`
- `context_update`
- `subscription_event`
- `interrupt`
- `handoff`

An inbox item may target:

- a specific agent;
- a subscribed group.

Role/capability queues are future work; v1 should prefer direct agent recipients and simple subscriptions.

V1 inbox states:

- `open`
- `accepted`
- `done`
- `cancelled`

Delivery bookkeeping should be separate from inbox state, e.g. `delivery_state`, `delivery_attempts`, and `delivery_error`. Future inbox states may include `deferred` and `declined`.

Example commands:

```bash
loom inbox send planner-a -L feature-x --type question --node N-0042 --message "Is this branch viable?"
loom inbox next planner-a
loom inbox accept M-0044
loom inbox done M-0044 --summary "Reviewed and added critique."
```

### Event Routing

Subscriptions are stored routing rules, not live listeners. For example:

```bash
loom agent subscribe lead-a -L feature-x --under N-0010
```

means future events under `N-0010` should route notifications to `lead-a`.

V1 routing inputs should be minimal:

- explicit inbox recipient;
- node creator or requester, when recorded;
- simple subtree subscriptions;
- explicit mentions, if easy to parse.

Future routing may include active participants, focus, role/capability queues, kind/tag subscriptions, and richer mention semantics.

Example: when a worker completes a node, `loom resolve` can notify the node creator, assignment requester, parent lead, and any subscribers.

### Delivery Bookkeeping

Inbox records are durable. V1 can keep delivery bookkeeping directly on inbox records:

- `delivery_state`: `none`, `delivered`, `failed`, `skipped_offline`, or `skipped_policy`;
- `delivery_attempts`;
- `delivery_error`.

A separate outbox table can be added later if one inbox item needs multiple transport attempts, richer retry logic, or detailed delivery auditing.

Delivery should happen after the state transaction commits. Delivery bookkeeping is internal diagnostics; agents should interact with inbox items, not delivery records.

Loom commands may opportunistically retry old failed/pending deliveries when they are already mutating or notifying the same Loom, but agents should not be expected to run explicit retry commands during normal work.

Delivered messages should include stable inbox IDs so duplicate delivery is safe:

```md
Loom notification M-0099

Loom: feature-x / lm_7k3f9x2a
Node: N-0042 Filesystem locking strategy
Event: resolved by worker-a

Open:
  loom -L lm_7k3f9x2a inbox show M-0099

Acknowledge:
  loom -L lm_7k3f9x2a inbox ack M-0099
```

### Delivery Detail Policy

The durable inbox item is canonical. Delivery messages are wake-up packets, not the authoritative work payload.

Delivery detail should be relationship-aware:

- parent/lead -> child/worker: send a delegation packet by default;
- child/worker -> parent/lead: send a completion summary by default;
- peer -> peer: send a request preview by default;
- subscription events: send an event summary or coalesced digest;
- high-volume/noisy subscriptions: send minimal ID/digest-style notifications.

V1 should not over-model packet taxonomy in schema. Rendering can use simple internal templates:

- `request`: item ID, sender, Loom ref, node title, request text, expected action, and suggested commands;
- `update`: item ID, actor, Loom ref, node title, short result/event summary, and inspection commands;
- `digest`: multiple related notifications grouped into one message.

Minimal ID-only notifications can be used for noisy cases, but should be a rendering policy rather than a first-class workflow agents need to understand.

Examples:

```md
New Loom delegation M-0099 from lead-a

Loom: feature-x / lm_7k3f9x2a
Node: N-0042 Filesystem locking strategy
Request: Review this design for race conditions and stale lock behavior.

Suggested:
  loom -L lm_7k3f9x2a inbox show M-0099
  loom -L lm_7k3f9x2a context N-0042 --budget 8000
```

```md
Loom completion M-0120

worker-a completed N-0042 Filesystem locking strategy.

Summary: Recommended atomic temp-file writes plus stale lock detection. Remaining risk: manual edits can bypass Loom locking.

Inspect:
  loom -L lm_7k3f9x2a inbox show M-0120
  loom -L lm_7k3f9x2a show N-0042
```

Even rich delivery packets should point agents back to Loom commands for canonical details.

### Delivery Transports

Loom should use capability-based delivery transports.

Baseline transports:

- `tango-message`: use Tango to send a message into an interactive tmux-backed agent session;
- `pull`: write durable inbox only; the agent checks when ready;
- `pi-in-process`: optional future/extension transport using `pi.sendUserMessage()` for cleaner delivery inside Pi sessions.

For v1, `tango-message` plus durable inbox is the primary immediate delivery path for interactive Tango agents. This keeps Loom runtime-agnostic across Pi, Claude Code, Codex, and other tmux-backed harnesses.

A Pi extension remains useful for Loom tools, UI status, context helpers, and possibly richer in-process delivery, but it is not required for the core no-daemon notification model. V1 should avoid requiring a Pi-specific transport.

## Tango Integration

Tango remains the process/session runtime.

Tango owns:

- starting agents;
- tmux sessions;
- process lifecycle;
- `look`, `message`, `result`, `stop`;
- role prompt assembly.

Loom owns:

- nodes and graph state;
- context generation;
- inboxes and subscriptions;
- agent participation and focus;
- durable work results.

### Resident Agents

A resident agent is an interactive agent that is not tied to a startup task.

Future Tango/Loom wrapper command:

```bash
loom spawn feature-lead-a --role planner -L feature-x
```

This would:

1. resolve the Loom;
2. write a Loom context file;
3. start a Tango interactive agent with Loom context in its environment;
4. optionally load a Loom extension when the harness supports it;
5. pass `LOOM_CONTEXT`, `LOOM_AGENT_ID`, and `LOOM_DEFAULT`;
6. register the agent as a participant.

### Ephemeral Dispatch

Bounded one-shot work is still useful:

```bash
loom dispatch N-0042 --role scout -L feature-x
```

This creates an inbox/run record, starts a Tango one-shot agent with generated context, then ingests the result when complete.

### Message Transport

Normal Loom notifications should flow through durable inboxes plus mutation-time delivery.

For interactive Tango agents, Loom should call Tango rather than implement process messaging itself:

```bash
tango message <agent> "<rendered Loom notification>"
```

This makes Tango the shared transport for Pi and non-Pi harnesses. Pi-specific in-process delivery can be added later as a higher-quality transport, but Loom's baseline should remain runtime-agnostic.

A useful future Tango improvement is file-based messaging for long notifications:

```bash
tango message <agent> --file /tmp/loom-message.md
```

## CLI Sketch

```bash
loom init --name feature-x --title "Feature X Design"
loom -L feature-x create "Recursive orchestration graph" --kind proposal
loom -L feature-x decompose N-0001 "Storage" "Search" "Agent inboxes"
loom -L feature-x branch N-0002 "Markdown" "SQLite" "Hybrid"
loom -L feature-x decide N-0002 --choose N-0009 --summary "Best v1 balance"

loom -L feature-x search "concurrent writes"
loom -L feature-x context N-0042 --budget 8000

loom agent join lead-a -L feature-x --role lead
loom inbox send lead-a -L feature-x --type question --node N-0042 --message "Review this branch"
loom notify lead-a -L feature-x --inbox M-0044

loom spawn feature-lead-a --role planner -L feature-x
loom dispatch N-0051 --role scout -L feature-x
```

## V1 Simplification Principles

V1 should implement the full vertical slice shallowly:

- prefer simple durable data over smart automation;
- keep agents focused on nodes, context, inbox items, notes, links, and results;
- hide delivery, indexing, registry repair, and storage internals from normal agents;
- allow custom edge/kind strings, but special-case only a small subset;
- treat event logs as audit logs, not a full replay engine;
- use BM25 + subtree filters before graph-distance reranking or embeddings;
- keep cross-Loom links as references before implementing cross-Loom traversal.

## Open Questions

- What should the final package/name be: `loom`, `lattice`, `workgraph`, or something else?
- Should Markdown or events be the canonical source if they diverge?
- Should v1 store cross-Loom references only, with traversal deferred?
- What is the minimal resident-agent support needed in Tango itself?
- Should `idle` become a Tango status, or should Loom own all participant state?
- Should role queues live per Loom only, or can there be global role queues?
- Should v1 implement only `tango-message` delivery, or also a Pi in-process transport?
- How much of delivery rendering should be configurable versus fixed simple defaults?
- Should failed delivery retry be purely opportunistic, or should there be human/operator-only diagnostics?
- Should Tango add `message --file` for long structured Loom notifications?
- What is the right split between shell CLI wrappers and direct library access from a future Pi extension?

## Recommended v1 Direction

Build Loom as a separate package with:

1. repo/spec-local `.loom` instances;
2. per-machine global registry;
3. Markdown node files;
4. SQLite projection with FTS5;
5. node creation, branching, decomposition, decision, traversal, and search commands;
6. basic context assembly;
7. agent join/subscribe/default commands;
8. durable inboxes with simple delivery bookkeeping;
9. command-emitted event routing with best-effort immediate delivery through Tango;
10. Tango integration through `loom spawn`, `loom dispatch`, and `loom notify` wrappers;
11. optional/future Pi extension for Loom tools and richer in-process delivery.

The central principle is:

```txt
CWD is not identity.
Agents are not tasks.
Branches are first-class.
Loom owns durable graph context.
Tango owns process execution.
```
