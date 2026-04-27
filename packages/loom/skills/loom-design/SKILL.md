# Loom Design Skill

Use this skill when assigned to develop a single coherent design direction for a Loom-backed proposal/spec/node. This is the normal design workflow; use `loom-branch-design` only when multiple materially different variants should be preserved.

## Operating model

You are the executing agent for design work. Do not invoke `/loom.design`; slash commands are root-session routing entrypoints. Use Loom CLI commands and this skill within the scope assigned by the parent/coordinator.

If assigned a mutation scope, mutate only that scope root and descendants. Do not edit parent nodes, sibling subtrees, or cross-subtree edges directly. If a cross-scope dependency, decision, review, or validation relationship is needed, include it as a requested coordinator action in your final result.

## Workflow

1. Fetch compact context for the assigned Loom node/scope first, preferably `loom context <node> --brief --json` when available.
2. Confirm the design goal, constraints, non-goals, and known evidence from the proposal/spec/context.
3. Identify whether a single design is appropriate. If there are genuinely competing architectures with different tradeoffs, stop and recommend `loom-branch-design` instead of forcing one design.
4. Produce a concrete design covering the relevant interfaces, data/schema/contracts, state transitions, error handling, rollout/rollback, observability, security/privacy, and validation strategy.
5. Record durable design notes or design child nodes only when the assignment authorizes Loom mutation.
6. Add references/artifacts for important source files or docs when helpful and in scope.
7. Surface architecture smells and unresolved decisions explicitly.
8. Return a mutation summary listing design nodes/notes/references updated, files touched if any, blockers, and recommended next skill/workflow.

## Output contract

Return:

- Scope root;
- Design summary;
- Key decisions and rationale;
- Interfaces/contracts affected;
- Data/schema/config implications;
- Rollout/rollback/observability/security considerations;
- Validation strategy;
- Open questions/blockers;
- Loom mutation summary;
- Requested coordinator actions;
- Recommended next action.
