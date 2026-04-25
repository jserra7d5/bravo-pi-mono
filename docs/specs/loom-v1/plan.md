# Loom v1 Implementation Plan

Status: draft plan  
Date: 2026-04-24

This plan implements the Loom v1 design as a shallow full vertical slice. The contracts are defined in `contracts.md`, operational behavior in `operations.md`, agent usage in `agent-guide.md`, testing expectations in `testing.md`, and broader rationale in `design.md`.

## V1 Scope

Build a separate CLI-first package, likely `packages/loom`, that supports:

1. initializing Loom instances;
2. creating and reading Markdown node files;
3. projecting nodes into SQLite with FTS5 search;
4. basic graph operations: decompose, branch, link, decide, resolve;
5. artifacts/references metadata;
6. per-machine registry and CWD-independent Loom resolution;
7. simple agent join/subscription/default state;
8. durable inbox items with simple delivery bookkeeping;
9. mutation-time event routing and best-effort Tango delivery;
10. context assembly for agents;
11. Tango wrappers for spawn/dispatch/notify.

## Non-Scope for V1

Defer:

- daemon/background relay;
- semantic embeddings/RAG;
- cross-Loom traversal beyond storing qualified references;
- role/capability queues;
- rich focus/idle/heartbeat semantics;
- separate outbox table;
- file-as-node modeling;
- advanced graph-distance search ranking;
- full event replay/time travel;
- required Pi extension/in-process delivery.

## Package Layout

Proposed layout:

```txt
packages/loom/
  package.json
  tsconfig.json
  src/
    cli.ts
    contracts.ts
    ids.ts
    paths.ts
    config.ts
    registry.ts
    markdown.ts
    nodes.ts
    graph.ts
    index.ts
    search.ts
    context.ts
    events.ts
    inbox.ts
    delivery.ts
    tango.ts
    artifacts.ts
    commands/
      init.ts
      create.ts
      show.ts
      tree.ts
      search.ts
      context.ts
      inbox.ts
      agent.ts
      registry.ts
  prompts/
    agent-guide.md       # packaged form of docs/specs/loom-v1/agent-guide.md
  roles/                 # optional future prompts/helpers
  README.md
```

`src/contracts.ts` should mirror `docs/specs/loom-v1/contracts.md` but the spec remains the canonical design reference until implementation stabilizes.

## Milestone 0: Package Skeleton

Deliverables:

- create `packages/loom` workspace;
- TypeScript build/check setup consistent with the monorepo;
- CLI entrypoint `loom`;
- shared JSON output envelope;
- basic test harness and fixture directory following `testing.md`.

Acceptance:

```bash
npm run build --workspace @bravo/loom
npm run check --workspace @bravo/loom
loom --help
loom --version
```

## Milestone 1: Instance Initialization and Registry

Implement:

- `loom init --name <name> --title <title> [--workspace repo=../../..]`;
- `.loom/loom.json` creation;
- `.loom/nodes`, `.loom/artifacts`, `.loom/runtime/context` directories;
- `.loom/runtime/runtime.sqlite` creation for canonical runtime state;
- `.loom/runtime/loom.lock` mutation lock behavior;
- `.loom/events.jsonl` creation;
- per-machine `~/.loom/registry.sqlite`;
- `loom registry list`;
- `loom registry resolve <id-or-alias>`;
- Loom resolution order for `-L/--loom`, qualified refs, env/context, registry default, CWD discovery.

Acceptance:

- A Loom can be initialized inside a nested spec directory.
- `loom -L <alias> ...` works from outside the Loom root.
- `loom show <alias>:N-0001` can parse a qualified ref even before nodes exist, returning a useful not-found error.

## Milestone 2: Operations Foundation

Implement:

- mutation lock acquisition/release;
- atomic Markdown/config writes;
- event append helper;
- ID allocation under lock;
- SQLite schema creation/migration using `PRAGMA user_version`;
- common error codes and exit codes;
- JSON success/error envelope;
- read/write separation for `index.sqlite` and `runtime/runtime.sqlite`.

Acceptance:

- Concurrent write attempts serialize or fail clearly with `LOCK_TIMEOUT`.
- A failed write does not leave partial node files.
- `loom index rebuild` cannot delete runtime inbox/subscription state.

## Milestone 3: Markdown Nodes and Graph Basics

Implement:

- node ID allocation (`N-0001`, `N-0002`, ...);
- slugged node file creation;
- YAML frontmatter read/write preserving Markdown body;
- `loom create <title> --kind <kind> [--parent <node>]`;
- `loom show <node>`;
- `loom tree [node]`;
- `loom decompose <node> <child...>`;
- `loom branch <node> <variant...>`;
- `loom link <from> --type <type> --to <to>`;
- `loom decide <node> --choose <node> --summary <text>`;
- `loom resolve <node> --resolution <resolution> --summary <text>`.

V1 semantics:

- `parent` handles containment/decomposition.
- `branch` creates variant nodes with `variant_of` edges to the source.
- `decide` creates a decision node and a `chooses` edge.
- Commands append audit events.

Acceptance:

- Users can create a root proposal, decompose it, branch one child, decide among variants, and view the tree.
- Node files remain readable/editable Markdown.

## Milestone 4: SQLite Projection and Search

Implement:

- `index.sqlite` schema from `contracts.md`;
- `loom index rebuild`;
- automatic projection updates after Loom commands;
- Markdown chunking by heading for FTS;
- FTS5/BM25 search over node title/body/chunks;
- `loom search <query> [-L loom] [--under node] [--kind kind] [--state state]`;
- closure table for descendant filters.

Acceptance:

- Deleting `index.sqlite` and running `loom index rebuild` restores traversal/search from Markdown files.
- `loom search` finds content in node bodies and can filter to a subtree.

## Milestone 5: Artifacts and References

Implement:

- `loom artifact add <node> <path> --copy --label <label> [--kind <kind>]`;
- `loom artifact list <node>`;
- `loom reference add <node> --workspace <id> <path> --label <label> [--kind <kind>]`;
- `loom reference list <node>`;
- update frontmatter and `node_files` projection;
- include artifacts/references in `loom show`.

Acceptance:

- Artifacts are copied under `.loom/artifacts/<node-id>/`.
- References remain external and workspace-relative.
- `loom show` lists both without dumping file contents.

## Milestone 6: Context Assembly

Implement:

- `loom context <node> [--query <query>] [--budget <tokens>]`;
- include node body, ancestor summaries, direct children, direct links, artifacts/references, workspaces, and optional search hits;
- human and JSON output.

V1 budgeting can be approximate. Prefer deterministic truncation over clever packing.

Acceptance:

- A spawned agent can receive enough context to work on one node without needing CWD discovery.
- References are listed but not expanded by default.

## Milestone 7: Agent Guide, Agents, and Inbox

Implement:

- `loom agent guide` to print the compact runtime-agnostic Loom agent guide;
- `loom --help` mention that agents can run `loom agent guide` for compact operating instructions;
- package a prompt/include copy of the agent guide for `loom spawn` and optional Tango role includes.

Then implement:

- `loom agent join <agent-id> -L <loom> --role <role>`;
- `loom agent default <agent-id> -L <loom>`;
- `loom agent subscribe <agent-id> -L <loom> [--under <node>]`;
- `loom inbox send <agent-id> --type <type> --node <node> --message <text>`;
- `loom inbox next [agent-id]`;
- `loom inbox show <item-id>`;
- `loom inbox accept <item-id>`;
- `loom inbox done <item-id> --summary <text>`;
- inbox state stored canonically in SQLite;
- audit events for inbox changes.

V1 inbox states:

- `open`
- `accepted`
- `done`
- `cancelled`

Acceptance:

- A lead can send a review request to a worker.
- The worker can inspect, accept, and mark it done.
- Agents never need to inspect delivery internals.

## Milestone 8: Mutation-Time Routing and Delivery

Implement:

- event routing for explicit recipients;
- simple subtree subscription routing;
- delivery rendering with simple `request`, `update`, and `digest` templates;
- `loom notify <agent-id> --inbox <item-id>`;
- best-effort `tango message <agent> <rendered notification>` delivery;
- delivery bookkeeping on inbox items;
- opportunistic retry only inside normal Loom mutations/notifications.

Acceptance:

- Creating/sending an inbox item to an interactive Tango agent attempts immediate delivery.
- Failed delivery does not lose the inbox item.
- Agents see an inbox item ID and useful request/update context, not outbox concepts.

## Milestone 9: Tango Wrappers

Implement:

- `loom spawn <agent-id> --role <role> -L <loom> [-- <extra tango args>]`;
- create a Loom context JSON file;
- pass `LOOM_AGENT_ID`, `LOOM_DEFAULT`, and `LOOM_CONTEXT` to Tango if Tango supports env passthrough, or via wrapper/bootstrap prompt if not;
- include or reference the Loom agent guide in the bootstrap prompt;
- register participant;
- `loom dispatch <node> --role <role> -L <loom>` for bounded one-shot work;
- optionally ingest Tango result into a Loom result/summary note.

Acceptance:

- `loom spawn` starts an interactive Tango agent with enough Loom context and Loom usage instructions to run `loom inbox next` and `loom context`.
- `loom dispatch` can assign bounded work against a node and preserve the result in Loom.

## Milestone 10: Hardening and Documentation

Implement:

- `loom doctor` basic checks for missing registry paths, missing node files, and stale projection;
- error messages for ambiguous Loom resolution;
- README examples;
- fixture-based smoke tests;
- contract conformance tests for node frontmatter and `loom.json`;
- required testing contract coverage from `testing.md`.

Acceptance:

- A new user can follow a README to initialize a Loom, create nodes, search, send an inbox item, and spawn/dispatch through Tango.
- The vertical-slice acceptance flow in `testing.md` passes from both inside and outside the Loom root.
- `npm run build` and `npm run check` pass for the monorepo.

## Initial CLI Surface

V1 target commands:

```bash
loom init
loom create
loom show
loom tree
loom decompose
loom branch
loom link
loom decide
loom resolve
loom index rebuild
loom search
loom context

loom artifact add|list
loom reference add|list

loom registry list|resolve
loom agent guide
loom agent join|default|subscribe
loom inbox send|next|show|accept|done
loom notify
loom spawn
loom dispatch
```

## Implementation Order Rationale

1. Storage and registry first, because CWD is not identity.
2. Markdown nodes next, because durable graph content is the core.
3. Operations foundations before broad mutation commands, because locking/atomic writes/error behavior should be consistent.
4. SQLite/search after nodes, because projection can be rebuilt.
5. Artifacts/references before context, because context needs to list them.
6. Agent guide before inbox/Tango, because not every Loom-aware agent is spawned by Loom.
7. Inbox/delivery after graph basics, because messages need node references.
8. Tango wrappers last, because Loom should work as a standalone CLI before orchestration.

## Risks and Mitigations

### YAML/frontmatter corruption

Use a conservative parser/serializer and preserve body content. Keep generated frontmatter simple. Add contract tests for generated and edited node files.

### SQLite divergence

Split `index.sqlite` and `runtime/runtime.sqlite`. Treat projection tables as rebuildable and runtime tables as canonical. Provide `loom index rebuild` early.

### Registry ambiguity

Require explicit `-L` when aliases conflict. Prefer stable IDs in generated agent context.

### Delivery fragility through tmux

Keep delivered messages short and include inbox IDs. Future Tango `message --file` can improve long notifications.

### Scope creep

Keep v1 shallow. If a feature requires a daemon, embeddings, complex queues, or rich live status, defer it.
