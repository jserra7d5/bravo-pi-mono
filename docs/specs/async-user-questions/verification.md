# Runtime Invariants and Verification

Testing is deliberately proportional. Extend the existing package tests and add a thin real-extension harness; do not create a new repository-wide test framework, browser lane, pseudo-terminal suite, or daemon fixture.

## Current-state probes and resolved contradictions

- Current `ask_user_question` is a single native tool whose `execute()` awaits `ctx.ui.custom()`.
- Current Escape resolves the component with `null`, causing the tool to return `cancelled: true`.
- Current state is process-local and has no pending request identity or persistence.
- Pi custom entries are durable TUI-only session entries and can be reconstructed from the active branch.
- `pi.sendMessage` supports `deliverAs: "followUp"` and `triggerTurn`, providing the intended safe answer-delivery boundary.
- `pi.sendMessage` and `pi.appendEntry` are separate non-transactional operations. V1 accepts bounded once-only delivery: duplicates are suppressed in live runtime and marked replay, while a crash between accepted enqueue and marker append may redeliver once.
- Pi does not prove restart restoration of unresolved tool executions; v1 explicitly does not claim it.

The design resolves the Escape contradiction by changing the picker’s presentation result and moving request lifecycle into the service.

## Compatibility & edge-case matrix

| Case | Current behavior | Intended behavior | Verification |
|---|---|---|---|
| Omitted delivery/urgency | Blocking picker | Blocking, normal urgency | Tool schema/execution test |
| Explicit non-blocking | Unsupported | Durable pending receipt | Real extension harness with captured custom entry |
| Escape blocking picker | Cancels tool/request | Withdraws request, clears badge/inbox, and releases tool | Component + coordinator test |
| Escape inbox picker | N/A | Returns to inbox; request pending | Component/inbox test |
| Duplicate tool execution | Creates independent modal | Same tool-call identity returns same request | Projection/service replay test |
| Answer pending non-blocking | N/A | One follow-up message and delivered event | Real extension harness |
| Answer active blocking | Tool returns answer | Tool returns answer; no async duplicate | Coordinator test |
| Escalate answered request | N/A | Immediate stored resolution | Service/tool test |
| Escalate pending request | N/A | Blocking waiter on same ID | Coordinator test |
| Withdraw pending | N/A | Terminal withdrawn, badge decrements | Service/badge test |
| Reload with pending | State lost | Branch projection restores badge | Session-start harness |
| Reload with undelivered answer | N/A | One async delivery | Session-start harness |
| Unknown/legacy custom entry | N/A | Ignored safely | Projection fault test |
| Non-interactive mode | Tool disables itself | All user-question tools disable clearly | Extension harness |

## Runtime invariants & verification seams

| Behavior (boundary) | Invariant (property) | Faithful seam | Injected fault |
|---|---|---|---|
| Tool call → durable request | A successful creation appends one valid event before returning/opening UI; replay of the same tool call creates no duplicate. | Register the real extension against a minimal Pi-shaped harness capturing actual registered tool execution and `appendEntry`. | Execute same tool-call ID twice. |
| Session entries → projection | Valid active-branch events reconstruct the same request state deterministically; invalid transitions and unknown versions do not corrupt projection. | Real projector over session-entry-shaped records. | Duplicate terminal event, answer after withdrawal, unknown version. |
| Picker → service transition | Inbox/non-blocking Escape produces no terminal event; blocking Escape produces exactly one withdrawal; explicit Submit produces exactly one answer. | Existing real component driven through keyboard input plus coordinator callback. | Submit followed immediately by Escape/repeated Enter. |
| Blocking waiter → answer | A live waiter consumes one terminal resolution through the tool result and suppresses async delivery. | Real coordinator with controlled component completion and captured `sendMessage`. | Duplicate answer callback. |
| Non-blocking answer → model delivery | Every resolved request without a live waiter produces at most one accepted `followUp` in a live runtime and no replay after a delivered marker; the documented enqueue/marker crash gap may redeliver once. | Real extension/runtime coordinator with captured `pi.sendMessage` and session entries. | Reload/replay before and after delivered marker; injected send failure. |
| Badge/inbox projection → TUI | Badge count equals unresolved actionable requests; opening/closing does not decrement it; order is blocking, urgency, age. | Pure projection plus real status callback capture and component render width checks. | Seen/opened request, mixed urgency, terminal request in history. |
| Escalation/withdraw conflicts | First valid atomic transition wins; repeated calls are idempotent and never reopen terminal state. | Service transition tests over revisioned event projection. | Answer vs escalate ordering; answer vs withdraw ordering. |
| Package discovery | Pi loads package and registers all three tools plus command/shortcut without loader errors. | Actual Pi package/extension load smoke in a non-destructive isolated session/config. | Non-interactive invocation disables UI-dependent tools. |

## Practical test scope

Required:

- preserve and adapt the existing 109 component/schema tests where behavior remains supported;
- add focused service/projector transition tests;
- add focused extension harness tests for persistence, delivery, default blocking compatibility, and non-interactive behavior;
- add width tests for badge and inbox cutoffs;
- run package check and package test;
- run one actual Pi extension-load smoke.

Not required:

- pixel/snapshot goldens;
- exhaustive permutations of every key;
- testing Pi core itself;
- a real terminal subprocess for every interaction;
- restart testing across an actual killed Pi process;
- performance benchmarking;
- broad monorepo tests unrelated to this package.

## Stop/re-plan triggers

Use the triggers in `design.md`. In particular, stop rather than faking a passing test if the extension harness cannot execute the real registration/persistence/delivery path.

## Definition of done

The real code path for each invariant above has executed green against its named local seam, including duplicate/replay or conflicting-transition injection. Package check/test and actual extension loading pass. Visual refinement is explicitly post-correctness and may follow user evaluation.
