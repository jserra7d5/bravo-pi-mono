# Loom v1 Agent Guide

Status: draft guide  
Date: 2026-04-24

This is the compact, runtime-agnostic guide for making an agent Loom-aware. Loom owns this guide. Tango, Pi, Claude Code, Codex, or another runtime may inject, paste, or reference it when starting or messaging agents.

## Core Mental Model

- Loom is durable graph context for research, design, planning, decisions, and work results.
- Tango or another runtime owns process/session execution.
- Agents are participants, not tasks.
- Nodes are generic work/thought artifacts, not necessarily implementation tasks.
- Branches and alternatives are first-class and preserved.
- Use Loom commands for durable updates so events, search, context, and notifications stay coherent.

## If You Are Not Already Loom-Aware

Run:

```bash
loom agent guide
```

For CLI reference:

```bash
loom --help
loom <command> --help
```

If a message gives you an inbox item ID, inspect it:

```bash
loom -L <loom-id-or-alias> inbox show <M-id>
```

If a message gives you a node ID, fetch context:

```bash
loom -L <loom-id-or-alias> context <N-id>
```

## Normal Worker Protocol

1. Inspect assigned or relevant work.
2. Fetch node context.
3. Do the requested research/design/review/implementation thinking.
4. Write durable notes/results back to Loom.
5. Mark the inbox item done, if you were working from one.

Useful commands:

```bash
loom current
loom inbox next
loom inbox show M-0001
loom inbox accept M-0001
loom context N-0001
loom show N-0001
loom search "query terms"
loom note N-0001 "Finding or result..."
loom resolve N-0001 --resolution answered --summary "Short outcome"
loom inbox done M-0001 --summary "What you did"
```

Prefer `loom context <node>` over manually reading many files. Prefer `loom note`/`loom resolve` over raw Markdown edits unless explicitly asked.

## Coordinator / Lead Protocol

Coordinator agents may also create structure and delegate work:

```bash
loom create "Title" --kind design
loom decompose N-0001 "Storage" "Search" "Agent inboxes"
loom branch N-0002 "Option A" "Option B"
loom link N-0003 --type critiques --to N-0004
loom decide N-0002 --choose N-0005 --summary "Why this option wins"
loom inbox send worker-a --type review_request --node N-0005 --message "Review this branch"
loom spawn worker-a --role worker -L <loom>
loom dispatch N-0005 --role scout -L <loom>
```

Use delegation when it reduces complexity or enables useful parallelism. Keep child-agent tasks bounded and name the expected deliverable.

## Runtime-Neutral Loom Awareness

An agent can be Loom-aware without currently being inside a specific Loom.

Examples:

- A Tango team lead role may know this guide but have no default Loom yet.
- A general resident agent may receive a Loom notification later and use the provided `-L <loom>` flag.
- An agent spawned with `loom spawn` should receive `LOOM_CONTEXT`, `LOOM_DEFAULT`, and a startup prompt that points to its default Loom.

When no default Loom is available, use explicit `-L` flags from the message or ask the parent/user for the Loom ID.

## Environment Context

Loom-spawned agents may receive:

```txt
LOOM_AGENT_ID=<agent-id>
LOOM_DEFAULT=<loom-id-or-alias>
LOOM_CONTEXT=<path-to-context-json>
```

You normally do not need to edit these. They help Loom commands resolve the right instance when CWD is not the Loom root.

## What Not To Do Unless Asked

Normal agents should not manage Loom infrastructure.

Avoid unless explicitly requested:

```bash
loom index rebuild
loom registry repair
loom doctor --fix
loom delivery ...
```

Do not edit:

```txt
.loom/index.sqlite
.loom/runtime/runtime.sqlite
.loom/events.jsonl
```

Do not manually retry delivery, clear locks, repair registry paths, or change SQLite state during normal work.

## Delivery and Inbox

Delivered messages are wake-up packets. The durable inbox item is canonical.

For immediate Tango delivery, the Loom recipient agent ID should match the Tango agent name unless an explicit runtime mapping exists. Example: if Tango starts an agent named `backend-worker`, send Loom inbox items to `backend-worker`. If the Loom recipient is `backend-worker` but the live Tango agent is named `backend-demo-worker`, delivery may fail, though the inbox item remains durable and can still be inspected manually.

If you receive a Loom notification, use the included command, usually:

```bash
loom -L <loom> inbox show M-0001
```

Then decide whether to accept, defer by telling your parent/user, or complete the item.

## Artifacts and References

Nodes may list artifacts and references.

- Artifacts are node-owned files in `.loom/artifacts/<node-id>/`.
- References point to source/spec files in workspaces.

Use:

```bash
loom artifact list N-0001
loom reference list N-0001
```

Do not dump large referenced files into chat unless needed. Use targeted reads/searches.

## Compact Command Cheat Sheet

Worker-facing:

```bash
loom current
loom inbox next
loom inbox show M-0001
loom inbox accept M-0001
loom inbox done M-0001 --summary "..."
loom show N-0001
loom context N-0001
loom search "..."
loom note N-0001 "..."
loom resolve N-0001 --resolution answered --summary "..."
```

Lead-facing:

```bash
loom create "..." --kind design
loom decompose N-0001 "A" "B"
loom branch N-0001 "Option A" "Option B"
loom decide N-0001 --choose N-0002 --summary "..."
loom inbox send agent-a --type review_request --node N-0002 --message "..."
loom spawn agent-a --role worker -L <loom>
loom dispatch N-0002 --role scout -L <loom>
```

Diagnostics are human/operator-facing:

```bash
loom doctor
loom index rebuild
loom registry list
```
