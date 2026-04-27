---
description: Route a Loom-backed proposal into a design workflow and select/designate the executing agent
argument-hint: "<loom/node or proposal> [design focus]"
---

Route and orchestrate design work for a Loom-backed proposal. Slash commands are root-session entrypoints: decide what should happen, choose or reuse the right executing agent, and hand that agent the matching Loom skill. Do not treat this prompt as the child agent's execution procedure.

User input:

```text
$ARGUMENTS
```

Workflow:
1. Confirm Loom context exists or identify the proposal/node that should become the design root.
2. Prefer reusing an existing persistent `loom-coordinator` for the Loom/workstream when one is active or can be resumed; create a new coordinator only when there is no suitable reusable coordinator.
3. Fetch relevant context (`loom context <node>` or inbox details) before dispatching design work.
4. Choose the execution path:
   - use a coordinator/lead/planner with the `loom-design` skill for the normal single-design workflow;
   - use a coordinator/lead with the `loom-branch-design` skill when alternatives should be preserved;
   - use `loom-clarify` first when the design brief is ambiguous;
   - use `loom-ready` when the question is whether design can begin or advance.
5. When dispatching child agents, instruct them to use Loom skills, not slash commands. Include the node/inbox reference, expected deliverable, mutation authority, validation/review expectations, and stop conditions.
6. For multi-writer design work, scope each writer to distinct nodes, branches, artifacts, or notes. Require mutation summaries that list created/updated Loom nodes, notes, decisions, branches, and any files touched.
7. Summarize routing decisions, assigned agents, and any durable Loom mutations or pending approvals.

Do not edit Loom internals directly. Do not bypass the coordinator with many unscoped writers.
