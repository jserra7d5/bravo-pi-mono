# Validation Plan

Status: implemented
Method: Joe-method seam-bound verification

## Runtime invariants & verification seams

| Behavior (boundary) | Invariant (property) | Faithful seam | Injected fault |
|---|---|---|---|
| Background task success with wake enabled | Exactly one model wake is accepted for the owner session after terminal metadata records `exited` and `exitCode: 0` | Real `bash` tool execution through the extension; fake only Pi `sendMessage` at the extension API boundary after Phase 0 proves real session binding semantics | Command exits immediately before any status poll |
| Background task failure with wake enabled | Non-zero failure cannot be only silently persisted; wake payload reports `failed`, exit code, output path, and bounded tail | Real spawned shell command | Command writes output/stderr then exits `7` |
| Background task without wake enabled | No model wake is sent, while metadata/output still record terminal state | Same real tool path with `wake_on_completion` omitted | Same success/failure commands |
| Timeout | Timeout kills owned process tree and emits exactly one owner-session wake with `timed_out` | Real spawned shell with child process and timeout | Shell starts child sleep longer than timeout |
| Manual stop | Stop of a live opted-in task produces exactly one owner-session `killed` wake or safely records no wake if ownership cannot be proven | Real `background_task_stop` tool against a live task | Stop races with natural process exit |
| Output cap / noisy task | Output-cap watchdog routes through terminal finalization: process stops, metadata says `killed` + `stopReason: "output_cap"`, and exactly one owner wake is accepted when enabled | Real command exceeding `maxOutputBytes` | Large stdout/stderr and multi-byte UTF-8 near boundary |
| Metadata-before-wake ordering | On wake receipt, `background_task_status` agrees with payload status/exit/output facts | Real tool runtime + fake sendMessage capture + immediate status read | Fast-exit task |
| Duplicate prevention | A task produces at most one wake claim/attempt even across exit/stop races and reload/reconcile, and post-wake status agrees with the canonical wake payload | Real runner path plus atomic durable notification claim and persisted metadata reload | Race stop/exit/finalize attempts; complete task, reload/reconcile, then inspect markers/status |
| Session routing | Wake is accepted only for the task owner session and never for another active Pi session sharing the data dir | Phase 0 real Pi session/sendMessage proof plus synthetic contexts sharing one real registry/output directory | Complete session A task while session B reconciles/lists/statuses |
| Delivery failure | Notification transport failure does not corrupt terminal state and is observable in metadata/log | Real terminal finalization path with async fake notifier resolving slowly, accepting, and rejecting | Delayed acceptance and throwing/rejecting send |

## Test matrix

### Core lifecycle tests

1. `wake_on_completion success emits one owner wake`
   - Start command: `node -e "console.log('ok')"`.
   - Assert task reaches `exited`.
   - Assert one fake `sendMessage` call with custom type, `triggerTurn: true`, `deliverAs: "followUp"`.
   - Assert metadata contains notification id/claim/attempt/accepted markers, not ambiguous delivered markers.

2. `wake_on_completion failure emits one owner wake`
   - Start command: `node -e "console.error('bad'); process.exit(7)"`.
   - Assert payload says `failed`, `exit_code` 7, tail contains `bad`.

3. `wake disabled remains quiet`
   - Run the same commands with no wake flag.
   - Assert terminal metadata exists and fake `sendMessage` count remains zero.

4. `timeout wakes once and kills process tree`
   - Start shell command that spawns a child sleep beyond timeout.
   - Assert terminal status `timed_out`, no child remains, one wake.

5. `manual stop wakes once or records ownership failure`
   - Start long command with wake enabled.
   - Call real `background_task_stop` from owner session.
   - Assert one `killed` wake if live ownership is verified.
   - Race variant: process exits while stop is requested; assert one terminal state, one/no duplicate wake, and post-wake `background_task_status` still matches the wake payload's canonical `status`/`exitCode`/`signal`/`stopReason`.

6. `output cap kills and wakes once`
   - Configure low `defaultMaxOutputBytes`.
   - Start wake-enabled command that exceeds it.
   - Assert process-tree termination, metadata `status: "killed"`, `stopReason: "output_cap"`, bounded/capped log evidence, and exactly one owner wake claim/acceptance.

### Tail and envelope tests

7. `tail bounded and UTF-8 safe`
   - Emit >16 KiB with multi-byte characters near cap.
   - Assert message content remains valid UTF-8, <= configured cap, and marks truncation.

8. `tail escaping is robust`
   - Include `]]>`, nested `<background_bash_notification>` text, ANSI escape sequences, and control characters in output.
   - Assert notification tail strips/normalizes controls and XML-escapes all text nodes without CDATA.

9. `content is model-sufficient`
   - Assert required fields are in message `content`, not only `details`.

### Session isolation tests

10. `real Pi sendMessage session binding proof`
   - Produce a checked-in API contract note/test or manual transcript using two real active Pi sessions or an official equivalent harness.
   - Assert the implementation can target only the owner session, or record that model wake is refused when no session-bound handle is available.

11. `two sessions one dataDir no drift`
   - Create contexts A and B with different `sessionManager.getSessionId()` and fake send sinks.
   - Start a wake-enabled task from A.
   - Reconcile/list/status from B before/after completion.
   - Assert only A sink receives wake; B receives none.

12. `session mismatch suppresses wake`
   - Start task with owner A.
   - Before terminal dispatch, make notifier/current session report B.
   - Assert no `sendMessage`; metadata records `SESSION_MISMATCH`.

13. `missing owner session suppresses wake`
   - Construct or start a task where owner session cannot be resolved.
   - Assert no model wake; metadata/log explain routing failure.

### Reload/reconcile tests

14. `terminal metadata reload does not duplicate wake`
   - Complete opted-in task and persist accepted marker.
   - Create new registry/runner over same data dir.
   - Reconcile.
   - Assert fake send sink remains one total.

15. `same-session running reload is explicit`
   - Start wake-enabled long task in session A.
   - Reload same session before terminal completion.
   - Assert later completion either wakes A through a reconstructed safe notifier/watcher or persists explicit wake-lost routing/liveness failure.
   - Silent loss is failure.

16. `running reload does not transfer session ownership`
   - Simulate running task from session A and reload/reconcile in session B.
   - Assert task is not woken by B.

### Validation and rollout tests

17. `timeout validation is precise`
   - Cover omitted timeout, `0`, `1`, negative, fractional, and too-large values.
   - Assert background accepts only omitted or integer seconds in the contracted range.

18. `legacy config/metadata true does not silently enable wake`
   - Use config with pre-existing `notifyModelOnCompletion: true`.
   - Use pre-existing running, orphaned, unknown, and terminal metadata with `wakeOnCompletion: true` but no `wakePolicyVersion: 1` / `wakePolicySource: "tool_arg_v1"`.
   - Assert no retroactive/config-default/reconcile wake in v1 without explicit per-call `wake_on_completion: true` that creates the v1 source marker.

### Prompt/behavior tests

19. `prompt guidance updated only after feature works`
   - Activation prompt no longer says wake delivery is unimplemented.
   - Prompt includes decision boundary for `wake_on_completion`.

20. `agent behavior eval`
   - Long test/build request: model should use `run_in_background` + `wake_on_completion`.
   - Dev server/watch request: model should use background without wake unless terminal alert is desired.
   - External log/CI observer: model should use Monitor, not background bash.

## Definition of done

The change is done when the real background bash code path has executed green against the seams above:

- real `bash` tool starts real background processes;
- real registry/output metadata is written;
- Phase 0 proves real Pi `sendMessage` session binding/acceptance semantics or the implementation refuses model wake without a session-bound handle;
- fake only the Pi model-delivery boundary (`sendMessage`) after that real API contract is proven, and assert its async accept/reject calls;
- failure paths include non-zero exit, timeout, stop, output cap, XML-breaking output, session mismatch, same-session reload, cross-session reconciliation, legacy config true, and delivery failure;
- documentation and prompt text accurately describe implemented behavior.

Mock-only tests of `notifications.ts` are useful unit coverage but are not sufficient for completion.

## Commands

Run at minimum after implementation:

```bash
npm run check --workspace @bravo/pi-extension-background-bash
npm test --workspace @bravo/pi-extension-background-bash
```

If shared types or extension APIs are touched outside the package, also run the affected workspace checks.
