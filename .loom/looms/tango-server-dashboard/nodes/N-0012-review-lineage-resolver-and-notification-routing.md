---
id: N-0012
title: "Review: lineage resolver and notification routing"
kind: review
state: open
parent: null
summary: "Review: lineage resolver and notification routing"
tags: []
created_at: "2026-04-27T00:47:15.452Z"
updated_at: "2026-04-27T01:43:58.855Z"
edges:
  - type: reviews
    to: N-0002
---





# Summary

Review: lineage resolver and notification routing

# Context


# Analysis


# Result

Pending.


# Note 2026-04-27T00:48:01.328Z

## Review scope

Review implementation of N-0002 and N-0011 before rollout.

Checklist:

- Shared resolver exists outside `cli.ts` and is used by `attach`, `look`, `result`, `message`, `stop`, `delete`, `children`, and `wait`.
- Resolution priority is lineage-first, cwd fallback second, global unique fallback last.
- Ambiguity fails safely and offers `--run-id`/`--run-dir` guidance.
- Cross-cwd parent/child targeting works without `cd`.
- `tango watch`/notification routing uses `parentRunId`/`rootSessionId` when available.
- `wait`/`result` mark relevant completion attention handled, preventing stale duplicate wake-ups.
- Legacy metadata remains usable only through fallback behavior.


# Note 2026-04-27T01:13:40.923Z

## Review result: BLOCKED

Reviewer `n0012-lineage-review` inspected the N-0002 implementation in `/home/joe/Documents/projects/bravo-pi-mono-tango-server`.

Validation observed:

```bash
npm run check --workspace @bravo/tango
```

passed, but the implementation is blocked against the N-0002/N-0012 contract.

Blocking findings:

1. `targetResolver.ts` root/workstream step is not actually descendant-aware; it uses flat same-root/same-workstream filtering and can select siblings, ancestors, unrelated same-workstream agents, or wrong-workstream agents.
2. `eventMatchesLineage` can fall back to cwd even when explicit lineage contradicts the current run, so unrelated same-cwd events can still route to the wrong parent.
3. Root/workstream event logic is over-broad and should be conjunctive when both are present.
4. `runDir` / `parentRunDir` comparisons are not normalized.
5. `wait` does not cache resolved targets and can retarget mid-loop.
6. Attention/dedupe checklist is not implemented yet; this remains a dependency before moving to N-0011 completion semantics.
7. `attach` / `message` do not enforce interactive/running policy clearly.
8. Ambiguity errors omit required fields (`role`, `cwd`, `parentRunId`, `rootSessionId`, `updatedAt`) and command examples.
9. Tests miss critical regression cases: sibling-not-descendant, root+workstream not OR, unrelated same-cwd event with lineage, normalized `parentRunDir`, wait target stability.
10. `package-lock.json` change adding `@bravo/caveman` appears unrelated to N-0002 and should be reverted or explicitly justified.

Required next action: run a focused fix pass before starting `N-0011`.


# Note 2026-04-27T01:43:58.855Z

## Re-review blocker fixes applied by coordinator

After `n0012-lineage-rereview` reported two remaining blockers, coordinator applied a direct fix in `/home/joe/Documents/projects/bravo-pi-mono-tango-server`:

- `resolveTarget()` now computes lineage context before cwd/global fallback and skips cwd/global fallback when lineage env exists.
- Added resolver regression test: same-cwd project candidate is not selected after lineage mismatch.
- `eventMatchesLineage()` now attempts metadata-backed ancestry walking for descendant events beyond direct children.
- Added event regression test for a grandchild status event matching an ancestor run by walking metadata lineage.

Validation passed:

```bash
cd /home/joe/Documents/projects/bravo-pi-mono-tango-server
npm test --workspace @bravo/tango
npm run check --workspace @bravo/tango
npm run build --workspace @bravo/tango
```

Test result: 31/31 passing.
