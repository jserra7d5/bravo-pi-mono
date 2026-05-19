---
description: Check whether a Loom node is ready for spec, design, plan, implementation, or review
argument-hint: "<mode> <loom/node> [focus]"
---

Route and orchestrate a readiness check for a Loom-backed workflow. Use Loom only if a Loom/node/inbox reference or Loom context is provided. Slash commands choose scope and execution; child agents execute with Loom skills, not slash commands.

User input:

```text
$ARGUMENTS
```

Modes may include `spec`, `design`, `plan`, `implement`, and `review`.

Prefer reusing the persistent `loom-coordinator` for this Loom/workstream when readiness affects shared sequencing or agent assignment. If delegating, instruct the child agent to use `loom-ready`, define read/write authority, and require a mutation summary (usually no mutations unless writing a Loom note was requested).

For implementation readiness, verify:
- chosen design/decision exists;
- task scope is clear;
- target repos, base branches/commits, and dirty state are known;
- worktree plan is defined when needed;
- validation commands/environment paths are known or explicitly deferred;
- tests, builds, git remotes, package installs, and network/API checks have explicit fail-fast timeout expectations and noninteractive git/SSH behavior where practical;
- review/validation path exists or is intentionally unnecessary;
- blockers and assumptions are explicit.

Return PASS/BLOCKED/READY-WITH-RISKS with concise reasons and next actions.
