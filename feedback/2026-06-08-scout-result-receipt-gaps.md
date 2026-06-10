# Scout subagent result/receipt gaps

Date: 2026-06-08
Reporter: Pi root session during ROGER behavior-eval work

## Summary

During a multi-task pipeline, some `scout` subagents reported task completion but did not provide a usable result body or task receipt. The parent received only a generic summary (`Submitted result for T-...`) and `task_get(..., view="receipt")` reported a missing receipt path. This forced task reopen/re-run even though the subagent status said completed.

The failure pattern was not that the scout was wrong; it was that the result was not readable/actionable through the task/result surfaces.

## Evidence 1 — T-0036 first scout map returned no usable mapping

Assigned task:

- Task ID: `T-0036`
- Title: `Map ROGER Workbench live_context session/turn contract`
- Agent: `scout`
- Variant: `gemini`
- Display name: `@Harper`
- Run ID: `run_mq4ojb4t_6VSxdxejaDU`

Task requested a detailed map of native ROGER Workbench interactive endpoints, auth, request/response schemas, execution flow, publish/final-chat persistence, IDs, hook points, and implementation plan.

Observed result surfaces:

- `task_get({ taskId: "T-0036", view: "receipt" })` returned:
  - `Result: Mapped ROGER Workbench HTTP interactive contract for live_context eval lanes, including routes, auth, background execution, Firestore/workspace updates, and adapter implementation plan.`
  - `Receipt diagnostic: missing - task result has no receiptPath`
- `subagent_result({ runId: "run_mq4ojb4t_6VSxdxejaDU" })` returned only:
  - `Submitted result for T-0036.`
  - Task receipt object only contained:
    - `state: submitted`
    - same one-line summary
    - `receiptDiagnostic: { state: "missing", message: "task result has no receiptPath" }`

Impact:

- Parent could not inspect the endpoint map or implementation details.
- The task had to be reopened and rerun with a stricter instruction: “MUST submit a detailed receipt; do not just summarize.”
- Second run with default `scout` (`@Emery`, run `run_mq4onc0m_MWbtrpiWpbQ`) produced a usable detailed receipt and was accepted.

## Evidence 2 — T-0044 first scout token-path map returned no usable details

Assigned task:

- Task ID: `T-0044`
- Title: `Map safe Workbench operator email to Firebase ID token path`
- Agent: `scout`
- Variant: `gemini`
- Display name: `@Jordan`
- Run ID: `run_mq4qquj4_a7Drfl9EJco`

Task requested exact evidence/commands for whether an approved `operator_email -> Firebase ID token` path exists, including Firebase Admin SDK secret/key usage, internal_admin claim setup/verification, Identity Toolkit exchange command/API sequence, required env vars, existing scripts/tests, and residual risks.

Observed result surfaces:

- `task_get({ taskId: "T-0044", view: "receipt" })` returned:
  - `Result: Mapped approved path to obtain a Workbench Firebase ID token for operator email. Mapped custom token minting via Firebase Admin SDK + FirebaseAdminKey secret, and the Identity Toolkit exchange path.`
  - `Receipt diagnostic: missing - task result has no receiptPath`
- `subagent_result({ runId: "run_mq4qquj4_a7Drfl9EJco" })` returned only:
  - `Submitted result for T-0044.`
  - Task receipt object only contained:
    - `state: submitted`
    - same one-line summary
    - `receiptDiagnostic: { state: "missing", message: "task result has no receiptPath" }`

Impact:

- The summary claimed a supported token path exists, but gave no commands, files, symbols, secret names, env vars, or safety constraints.
- Parent could not safely act on the result.
- The task had to be reopened and rerun with a hard detailed-receipt requirement.

## Common failure mode

The task state/result pipeline allowed a child to mark the task as result-ready/completed while the actual task receipt was missing. The parent-visible result body did not contain the requested deliverable and `subagent_result` did not recover it.

Common visible markers:

```text
Receipt diagnostic: missing - task result has no receiptPath
```

and:

```text
Result body:
Submitted result for T-....
```

## Why this hurt orchestration

- These were retrieval/map tasks where the receipt is the main artifact.
- The one-line summary was not enough to define implementation work safely.
- Downstream tasks were blocked or would have been poorly specified.
- Parent had to spend extra turns reopening and relaunching tasks.
- For T-0044, the missing details were security-sensitive; acting on an unsupported token-mint path would be unsafe.

## Suggested tool/harness improvements

1. **Do not allow `task_submit_result` without a body or receipt for task-owned runs.**
   - If a child submits only generic text like `Submitted result for T-0044`, mark it as failed/invalid, not result-ready.

2. **Validate receipt presence for task-owned child results.**
   - If `receiptPath` is missing, expose the child’s final answer body directly if available.
   - If neither exists, surface a clear child failure instead of a successful task result.

3. **Add deliverable-aware minimum result checks for scout tasks.**
   - A scout result should include at least paths/symbols/evidence or an explicit “not found” conclusion.
   - Empty/generic completion messages should fail fast.

4. **Make `subagent_result` recover the actual final assistant content when task receipt is missing.**
   - In both cases above, `subagent_result` repeated the generic submitted message and did not expose the substantive scout work, if any existed.

5. **Consider warning when `summary` claims details exist but receipt is missing.**
   - Example: T-0044 summary claimed the token path was mapped, but no commands/evidence were available.

## Successful contrast

Rerunning T-0036 with stricter instructions using default `scout` produced a detailed, usable receipt:

- Task ID: `T-0036`
- Agent: `scout`
- Display name: `@Emery`
- Run ID: `run_mq4onc0m_MWbtrpiWpbQ`
- Receipt included endpoint list, auth headers/env, schemas, native execution flow, publish/chat surfaces, IDs/cleanup labels, and source evidence.

This suggests the issue is not impossible task scope; it is inconsistent result/receipt capture or child compliance enforcement.
