# Audited Gap Remediation Plan

## Verdict and objective

**READY.** Close only the accepted audit findings **UTP-001** and **UTP-002** and
the four named proof gaps. Preserve `contracts.md` unchanged: no new tool fields,
states, failure tiers, compatibility paths, scheduler, registry, or process model.
Completion means the two runtime invariants below pass through real child/process,
filesystem-registry, tool-execute, and Pi-loader seams; a green unit-only substitute
is insufficient.

This plan supersedes the original construction plan for the remediation work. The
implemented architecture and its ownership remain as specified by `design.md` and
`wiring.md`.

## Accepted findings and direction

### UTP-001 — shutdown can outlive monitor lease authority

Accepted source evidence:

- `SupervisedProcess` records leader `exit`, but when termination was requested it
  returns without arming stdio drain. If group death was confirmed just before that
  callback, `confirmGroupDeath()` had no leader to act on; neither side subsequently
  arms the 5 s drain timer. A detached descendant retaining inherited pipes can then
  hold `closed` indefinitely.
- `TaskEngine.beginShutdown()` disables claims **and** stops the periodic subscriber.
  That subscriber is the existing owner of lease renewal. Monitor shutdown can spend
  5 s in TERM→KILL escalation plus 5 s in bounded stdio drain, crossing the 10 s
  lease before `suspendClaimed()` durably commits.

Smallest coherent change:

1. In `process-tree.ts`, make leader observation and group-death observation
   order-independent: once both are true, arm the existing stdio-drain timer exactly
   once. Do not change signal scope, escalation delays, or detached-descendant policy.
2. In `engine.ts`, keep the existing periodic lease-renewal owner alive while shutdown
   has leased live attempts, but keep `claimsEnabled=false` so no new work can be
   claimed or spawned. In shutdown mode the periodic path should do only the control
   work still required for owned live attempts (especially `renewLeases`), then use
   the existing idle/unsubscribe path after suspension/finalization or terminal error
   cleanup. Do not add a second renewal timer or extend the lease constant.

Runtime invariant **S**: from durable suspension request until durable
`suspendClaimed`, the same runtime retains an unexpired fencing token; shutdown
confirms managed-group death, bounds retained-pipe drain, clears PID/PGID/runtime/token,
leaves a monitor `running + suspended`, emits no shutdown notification, and returns
only after that state is durable.

Tradeoff: the shared clock remains subscribed slightly longer during teardown. This
is preferable to duplicate lease-renewal logic; claim admission remains synchronously
disabled, so it cannot restart polling or admit work.

### UTP-002 — synchronous output startup failure is reported as running

Accepted source evidence:

- `spawnStream()` catches `new OutputWriter(...)` failure, calls `finish(...,
  "failed")`, and returns normally.
- `startBash()` and stream `startMonitor()` therefore return the originally admitted
  `running` record, and `tools.ts` emits “started”, even though canonical metadata is
  already `failed`.
- `claimAndSpawnStream()` currently catches broadly, so a propagated writer setup
  error must not be converted into a stream-claim retry after the record was
  terminalized.

Smallest coherent change:

1. Keep output setup and terminal classification owned by `TaskEngine`. Have the
   stream spawn path report its synchronous setup error to its immediate starter
   after first durably finalizing the admitted task as `failed`; do not construct a
   child and do not schedule a claim retry for that terminal task.
2. Let the existing `bash`/`monitor` tool `try/catch + normalize` boundary map the
   propagated error to the locked `runtime` shape. Change `tools.ts` only if needed
   to preserve that existing normalization; add no special response shape or shim.
3. Async child spawn failures remain normal post-start terminal failures. This change
   is limited to synchronous `OutputWriter` construction/open failure.

Runtime invariant **T**: a successful background-bash or stream-monitor start response
implies synchronous output persistence was established before process construction.
If that setup fails, the tool returns `{error_type:"runtime", ...}`, never “started”;
the admitted record is durably `failed`, no child side effect occurs, and normal
terminal dispatch semantics remain in force.

Ownership is reused, not duplicated: `process-tree.ts` owns group/close ordering;
`TaskEngine` owns startup, leases, and durable lifecycle; `tools.ts` owns boundary
normalization; `TaskRegistry`, `OutputWriter`, and the public contracts do not move.

## Dependency-ordered implementation increments

1. **Process close ordering (`packages/task-plane/src/process-tree.ts`).** Introduce
   one internal “leader observed + group dead” convergence path used by both event
   orders. Preserve idempotent finish/drain guards and the existing 5 s default.
   Gate: existing natural-close, escalation, same-group descendant, and detached
   stdio tests remain green.
2. **Shutdown lease continuity (`packages/task-plane/src/engine.ts`).** Separate
   “disable new claims immediately” from “unsubscribe the clock after owned live
   teardown.” Reuse `renewLeases`; ensure stale callbacks are generation-fenced once
   teardown is idle. Gate: a leased monitor that consumes approximately 5 s
   escalation plus 5 s drain durably suspends rather than expiring/orphaning.
3. **Truthful synchronous starts (`packages/task-plane/src/engine.ts`; review
   `tools.ts`, edit only if necessary).** Propagate writer-open setup failure after
   failed-state persistence, and distinguish it from retryable claim acquisition
   faults. Gate: both public start verbs return normalized runtime errors and launch
   no child while their records are failed.
4. **Close only the required proof gaps (`packages/task-plane/test/`).** Add/reshape
   the minimal behavioral cases below. Combine bash/stream cases in table-driven
   tests where their expected property is identical. Do not add tests for deleted
   strings, old vocabulary absence, or a larger fault matrix.
5. **Review and integration.** Run focused gates, then the complete package suite.
   Review the final diff against invariants S/T and the unchanged contracts; do not
   approve based only on test names or mocked lifecycle state.

## Minimal faithful proof set

| Proof | Faithful seam and stimulus | Required evidence |
|---|---|---|
| UTP-001 escalation + drain across lease | POSIX real shell/process group. A same-group process ignores TERM (forcing the existing 5 s escalation) while a detached descendant retains inherited stdio (forcing the existing drain allowance). Call real `TaskEngine.shutdown`; record and clean the detached PID in `finally`. | Elapsed path crosses the 10 s lease boundary; shutdown resolves boundedly; managed group is dead; canonical monitor is nonterminal `running`, `attempt_phase="suspended"`, has no PID/PGID/runtime/token, is not orphaned, and emits no notification. This single case proves group/exit order convergence and renewal during shutdown. |
| UTP-002 output open | Invoke the actual `buildTools` bash and stream-monitor `execute` functions with a real temp `TaskRegistry` and a `TaskEngine` whose `OutputFsPort.open` fails at output-writer construction. Commands contain a filesystem side effect. | Each result is normalized `runtime`, contains no start success; each admitted record is durably `failed`; side-effect files do not exist; no process ownership metadata is retained. |
| Kill mid-output | Real long-running child writes a recognizable prefix and later side effect; after prefix/PID observation, externally send `SIGKILL` to its real managed process group. | Output contains the prefix, late side effect is absent, terminal state is `failed` with `signal=SIGKILL`, ownership fields are cleared, and terminal dispatch occurs once. |
| Sustained flood | Real stream monitor emits 301 newline events gradually across multiple throttle flushes but within one 60 s rolling window. | Raw pre-batch count reaches 301; task stops with `stop_reason="event_flood"`; process is gone; throttle batching did not reset or mask the rolling count. Existing 299/300 and burst cases need not be duplicated. |
| Legacy retirement | Load the real extension through `DefaultResourceLoader`/`AgentSession` with both legacy roots present and records represented by unreadable/blocking sentinels; bound the load. Load again against the same unified root while capturing warnings. | First load creates both 0600 unified markers and logs each notice once; second load neither rewrites nor logs them; legacy roots/sentinels remain byte/metadata-identical and loading does not block/open record contents. No migration or vocabulary-absence assertion. |
| Explicit nonzero exits | One table-driven real-process test runs `printf` then `exit 7` through background bash and stream monitor. | Both preserve pre-exit output, durably become `failed`, persist and notify `exit_code=7`, clear ownership, and dispatch once. Keep the existing interval nonzero test. |

The long UTP-001 case is intentional and self-verifying; do not replace it with a
scripted clock decision, direct registry mutation, or fake process. Skip only on
Windows where POSIX groups/`setsid` are unavailable, while retaining existing
cross-platform unit coverage.

## Validation commands and evidence

Run from an isolated worktree (never the live main checkout), foreground, with
explicit bounds and untruncated output:

```bash
cd packages/task-plane
timeout 60s npm run check
timeout 120s npm run build
timeout 90s node --test \
  --test-name-pattern='shutdown.*lease|output.*open|kill.*mid-output|sustained flood|legacy retirement|nonzero.*bash.*stream' \
  dist/test/runner.test.js dist/test/core.test.js dist/test/host.test.js
timeout 240s npm test
```

For the focused gate, use the final test names in the regex and fail if it selects
zero tests. Record: command, exit code, elapsed time of the boundary-crossing case,
canonical metadata snapshots, process-death/side-effect assertions, and first/second
retirement warnings. “Tests pass” without those real-path observations is not
completion evidence.

## File and lane ownership

- **Runtime implementation lane (single writer):**
  `packages/task-plane/src/process-tree.ts`, then
  `packages/task-plane/src/engine.ts`; `packages/task-plane/src/tools.ts` only if
  propagation exposes a normalization defect. One owner avoids competing shutdown
  or startup paths in `engine.ts`.
- **Behavioral validation lane (single writer after runtime API stabilizes):**
  `packages/task-plane/test/runner.test.ts` for process/shutdown/flood/nonzero;
  `core.test.ts` for the tool-boundary open fault if that keeps the existing test
  organization; `host.test.ts` for the real-loader retirement proof. Reuse existing
  helpers rather than creating a harness subsystem.
- **Adversarial review lane (read-only):** inspect the above files plus
  `src/index.ts`, `src/output.ts`, `src/registry.ts`, `contracts.md`, and `wiring.md`.
  Review specifically for a second renewer, post-terminal claim retry, false start
  success, signaling outside the managed group, flaky time-only assertions, and
  tests that mutate metadata instead of exercising the owner.

No production file outside the three named runtime files is expected to change.
No spec contract, schema, data layout, migration, prompt, dispatcher, or registry
change is in scope.

## Stop / re-plan triggers

Stop rather than broadening the patch if any of these is observed:

- preserving lease authority requires a second lease owner, a lease-duration change,
  or a registry/schema change rather than reuse of `renewLeases`;
- ordering cannot be made convergent inside `SupervisedProcess` without signaling or
  supervising detached descendants;
- truthful startup requires making tool starts asynchronous, changing public return
  shapes, or suppressing required terminal dispatch;
- the real process-group, tool-execute, or Pi-loader seam cannot deterministically
  expose the stated property under bounded execution;
- the retirement proof discovers actual record access/migration or a live legacy
  consumer (that is a compatibility decision, not remediation scope);
- a proposed fix adds a fallback, dual path, adapter, new subsystem, or expands the
  fault matrix beyond the six proof rows above.
