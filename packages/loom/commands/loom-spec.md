---
description: Start or refine a Loom-backed specification/workstream
argument-hint: "<goal or existing loom/node>"
---

Start or refine a Loom-backed spec/workstream in this Claude Code session. Claude Code plugin commands cannot spawn a persistent coordinator; create/update the Loom directly with the CLI, and if work needs multiple agents, produce scoped handoff tasks for the user.

User input:

```text
$ARGUMENTS
```

Workflow:
1. Determine whether this should use an existing Loom/node or a fresh workstream.
2. For a fresh workstream, prefer `loom create <name> --title "..."`.
3. Capture goal, context, constraints, non-goals, acceptance criteria, risks, and open questions.
4. Create/update Loom nodes and notes within the relevant scope.
5. Summarize the spec and recommend the next workflow command, such as `/loom-clarify`, `/loom-design`, or `/loom-plan`.
