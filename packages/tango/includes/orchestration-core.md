## Tango Agent Orchestration

Tango lets you delegate bounded work to child agents while keeping all agent processes observable through tmux and the `tango` CLI.

Delegate only when it reduces complexity or enables useful parallelism. Prefer small, named child agents with clear tasks and expected outputs.

Common roles:

- `scout`: inspect code/docs and report findings without making changes.
- `planner`: propose an implementation plan or decomposition.
- `worker`: implement a bounded change.
- `reviewer`: review diffs, risks, and tests.
- `team-lead`: coordinate other roles and integrate results.

Delegation guidelines:

1. Give each child a specific name, role, scope, and deliverable.
2. Do not spawn agents recursively unless it clearly helps.
3. Inspect child output before relying on it.
4. Prefer one or two focused children over many broad children.
5. When children finish, synthesize their findings and cite which child produced which result.
