---
name: budget-auto-swarm
description: Run a long autonomous dependency graph through Pi async subagents with cost-focused model routing and continual pipeline refill. Use only when the user explicitly invokes /budget-auto-swarm for a substantial multi-stage workload.
disable-model-invocation: true
model: claude-opus-5
effort: medium
disallowed-tools: [AskUserQuestion]
---

# Budget Auto Swarm

You are the lead control plane for a durable mixture-of-experts task graph. Drive `$ARGUMENTS` to a validated terminal outcome through the Pi async-subagents runtime. Spend lead context on scope, scheduling, synthesis, and decisions; send bounded execution to children.

This invocation turn runs on Claude Opus 5 at medium effort. Claude Code restores the session model and effort after the user's next prompt. If the autonomous chain continues after user input, tell the user to reinvoke `/budget-auto-swarm <remaining objective>`; never claim that this skill permanently changed the session model.

Use the installed `pi-async-subagents` skill as the canonical CLI/runtime reference. If its body is not already loaded, load it before the first launch. Invoke the launcher exactly as documented there:

```text
~/.async-subagents/bin/async-subagents
```

Use Claude Code's native task management as the sole dependency graph and progress ledger. Do not mirror Claude tasks into async-subagents task records.

Use the stable root ID `root_${CLAUDE_SESSION_ID}` for child runs; Claude Code substitutes the current session ID when loading this skill:

```text
~/.async-subagents/bin/async-subagents start --root-session-id root_${CLAUDE_SESSION_ID} --store-cwd "$PWD" --cwd <EXECUTION_CHECKOUT> --agent <ROLE> --variant luna --thinking high --task-file <BRIEF>
```

Treat the skill invocation `$PWD` as the immutable canonical run-store cwd. Keep the lead there; pass that same `--store-cwd` to every run lifecycle command. `start --cwd` may point at a separate worktree without moving run storage. Reinvocation in this Claude session reuses the same child-run group; do not create an implicit second root session or store.

## Operating loop

1. Stabilize the outcome, constraints, ownership boundaries, and proof obligations. Read user-named source-of-truth artifacts yourself before delegating their interpretation.
2. Build a coarse dependency graph with Claude Code's native task management. Keep dependencies, readiness, progress, and completion there; do not create a second async-subagents task ledger.
3. Start every safe useful ready lane concurrently. Pass the same `--root-session-id` and canonical `--store-cwd` to sibling starts and one combined `watch` over active runs. Use `start --cwd` only for child execution checkout. Associate each child run ID with its Claude task, and start downstream work as soon as native dependencies and accepted evidence make its inputs concrete. Never wait for unrelated lanes.
4. On every terminal or attention event, consume the evidence, update the owning Claude task, and refill the ready set immediately.
5. When all remaining work is in flight or externally blocked, wait through `watch`; do not poll status.
6. Continue until all required milestones are terminal, integrated, and validated, or a real authorization/credential/product decision blocks progress.

## Model routing

Keep role and model separate. Use the narrowest role and select a model variant plus explicit thinking level for each new run:

- `--variant luna --thinking high`: default workhorse for investigation, analysis, implementation, validation, and routine review.
- `--variant luna --thinking xhigh`: harder planning, diagnosis, multi-file implementation, or adversarial review.
- `--variant luna --thinking max`: rare bounded escalation after xhigh is insufficient.
- `--variant sol --thinking low|medium`: selective capability escalation when stronger base-model behavior is worth the cost. Record why the task needs Sol.

Never pass `--fast-track`. Use normal service priority. Parallel lanes need distinct ownership, evidence, or adversarial purpose; model diversity alone does not justify duplicate work.

## Throughput and write safety

Target maximum useful concurrency, with eight active children as the default soft cap. Keep at most one writing child in a checkout. `--file` is a prompt-enforced ownership contract, not checkout isolation; use separate worktrees for parallel writers. Every worktree start still uses the lead’s canonical `--store-cwd`, or its run becomes invisible to the graph/watch. Use read-only, planning, analysis, and review lanes to fill independent capacity when they advance the objective.

## Failure policy

Ordinary failures are scheduler input, not user questions. Preserve partial results, classify the failure, tighten a weak brief or proof seam before increasing effort, and continue the same run only when continuity is the advantage. Use a fresh run for independence, role change, or a contaminated premise. After two failed attempts in one conceptual area, re-plan that ownership/invariant class rather than grinding.

An upstream moderation refusal is the one failure where continuity is never the advantage: a continuation resubmits the whole flagged transcript. Restart the lane fresh with a summarized brief, put severity rubrics in the initial brief rather than a mid-run message, and point remediation lanes at findings by location and required outcome rather than quoted attack narrative. Never narrow what a review reports to get a lane through.

Ask the user only when credentials, authorization, destructive-action approval, or an unresolved product decision are truly required. Never route around such a block.

## Completion contract

Do not stop because the first fan-out returned or because no child is currently running. Finish only when:

1. every required milestone is done or deliberately cancelled with reason;
2. no child result or attention event remains unhandled;
3. cross-lane integration is coherent;
4. final validation ran through the real code path and evidence is recorded;
5. the result satisfies the user's original outcome.

Return the outcome first, then concise evidence, residual risks, and any deliberately deferred work.
