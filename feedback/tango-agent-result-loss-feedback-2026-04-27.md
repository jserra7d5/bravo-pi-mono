# Tango agent result/feedback loss during delegated audits

Date: 2026-04-27

## Summary

During a Quantiiv/ROGER debugging session, delegated Tango agents repeatedly completed with useful work apparently done, but the parent session could not retrieve the actual detailed findings from Tango. Both `tango_result` and `tango_look` only showed a terse one-line summary such as:

```text
Prompt committed; auth findings ready
```

or:

```text
Completed static auth guard audit
```

This forced the parent/root agent to reconstruct the child agent's findings manually by re-reading files and rerunning searches, defeating much of the value of delegation.

## Observed cases

### 1. `smart-roger-data-worker-prompt-and-auth`

Role: `general-smart-agent`

Task included two phases:

1. Patch and commit the ROGER data-worker prompt.
2. Investigate local API auth failures and deliver root-cause findings.

Tango status said:

```text
Prompt committed; auth findings ready
```

But retrieval showed only the one-line result:

```text
Prompt committed; auth findings ready
```

`Tango look` also only showed that line. The detailed auth findings were not available in the agent result stream/artifact. I had to inspect git commits and source files directly to recover the probable findings.

### 2. `quantiiv-api-unified-auth-audit`

Role: `general-smart-agent`

Task was a static audit of `quantiiv-api` controller guards to identify endpoints that should possibly use `UnifiedAuthGuard` for ROGER/QAS agent-session JWTs.

Tango status said:

```text
Completed static auth guard audit
```

But `tango_result` returned only:

```text
Completed static auth guard audit
```

`Tango look` also only showed that same line. No audit report was retrievable, even though the task explicitly requested a structured report. I again had to manually fetch/search/read controller files to reconstruct the audit.

## Why this is a problem

- The parent/root session cannot reliably synthesize child-agent work.
- User-facing answers may omit important child-agent details unless manually reconstructed.
- Delegation becomes risky for audits/research because the actual findings may be lost.
- The parent agent may falsely believe a child delivered findings because the status says so, while the retrievable result contains only a summary.
- It wastes time and tokens because the root agent has to duplicate the child investigation.

## Expected behavior

When an agent completes a research/audit/planning task, the full final report should be retrievable through at least one of:

- `tango_result <agent>`
- `tango look <agent>`
- a known result artifact path
- an explicit durable transcript/log

A one-line completion summary is not sufficient unless the task explicitly asked for only a one-line result.

## Actual behavior

For both agents above:

- Tango reported the agents as `done`.
- The status summary suggested findings were ready.
- `tango_result` returned only a short summary line.
- `tango_look` returned only the same summary line.
- The run directory contained `result.md`, but it also only contained the short summary.
- There was no obvious detailed report artifact in the run directory.

## Possible contributing causes

These are hypotheses, not confirmed root causes:

1. The child Pi harness may be summarizing final output into metadata/result without preserving the full final assistant message.
2. The agent may be calling a status/result completion path that overwrites or truncates its actual final answer.
3. `tango_result` may be reading `result.md`, while the full transcript is stored elsewhere or not stored at all.
4. `tango_look` may only expose final stdout/status output, not the model's final response.
5. The role/harness prompt may encourage agents to emit concise status summaries instead of full deliverables.

## Requested fixes / improvements

1. Ensure completed agents persist their full final response, not just status summary.
2. Make `tango_result` return the full deliverable by default.
3. If a concise summary is desired separately, store it separately from the full result.
4. Add a guardrail: if a task requests a report/audit/findings and the final result is under some small threshold, warn the parent or mark the result incomplete.
5. Consider requiring agents to write final deliverables to a known file/artifact when task type is research/audit/planning.
6. Improve `tango_look` or provide a transcript command that reliably shows the final assistant response and not only process stdout/status.

## Impact in this session

This directly affected Quantiiv ROGER eval debugging:

- Prompt patch commit was recoverable from git.
- Auth root-cause findings had to be reconstructed manually.
- Unified auth audit findings had to be reconstructed manually.

The issue is high priority because it undermines trust in delegated agent work and makes parent-agent synthesis unreliable.
