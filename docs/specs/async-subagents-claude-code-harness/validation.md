# Validation Plan and Runtime Invariants

This feature follows the Joe Method: every boundary-crossing behavior needs a runtime invariant, a faithful seam, injected faults, and a definition of done that proves the real code path ran.

Normal validation must not require live Claude credentials. Live Claude smoke is useful but optional.

## Validation matrix discipline

Every lane below must define:

- entry command or test file group;
- real boundary/seam under test;
- deterministic setup and timeouts;
- injected faults;
- concrete assertions over tool results, run files, process state, wakeup text, and redacted logs;
- failure artifacts to archive.

The scripted smoke can cover multiple lanes, but a lane is only satisfied when it exercises the exact real seam named here.

## Required automated validation lanes

### 1. Definition resolution and command construction

Seam: real `startSubagent()` creates a temp run directory and launch metadata while using fake `claude` on `PATH`.

Must assert:

- selected variant resolves to `harness=claude` and default `mode=interactive` unless explicit oneshot;
- base Pi tools/extensions/thinkingLevel are not inherited across the harness boundary and provenance is recorded;
- explicit Claude-variant `tools`, `extensions`, or `thinkingLevel` fail pre-spawn;
- unknown harness, malformed model/effort/execution mode, missing Claude auth for `dangerous-auth`, missing Claude binary, and interactive transport unavailable fail pre-spawn with no child process;
- default argv does **not** include `--bare` and does include `--dangerously-skip-permissions`, system prompt file, strict MCP config appropriate for mode, disallowed `Task`, model, effort, and generated settings path;
- full task text and secret sentinel strings are absent from argv, launch logs, status details, and result tails;
- launch metadata records whether auth uses seeded run-home or operator-home; credential env/files are redacted;
- generated MCP config contains no ambient operator MCP servers;
- launch logs are redacted.

### 2. Parent prompt, catalog, and tool-surface lane

Seam: render/register real Pi extension surfaces (`promptModule.ts`, `agentCatalog.ts`, `schema.ts`, `tools.ts`) against fixture agent definitions.

Must assert:

- parent system prompt explains harness-aware variants, Claude skill semantics, no Pi tools/extensions, wakeup-first orchestration, and handled ack behavior;
- catalog reports effective Claude harness/mode/effort/model/execution mode and plainly labels Claude variants trusted/dangerous;
- tool schemas/descriptions document Claude `thinkingLevel` rejection, `ackLevel`, `ackTimeoutSeconds`, logical skills, and status/result metadata;
- path-like `skills` are rejected at `subagent_start` schema/tool boundary;
- mixed Pi/Claude variants render without stale legacy instructions.

### 3. Claude child prompt assembly lane

Seam: real prompt assembly writes `artifacts/system.md` and `artifacts/task.md` for Pi and Claude definitions with inherited includes.

Must assert:

- Claude prompt includes the child runtime contract: `subagent_event`, `subagent_read_inbox`, `subagent_ack_inbox`, `subagent_block`, `subagent_complete`, `subagent_liveness`, handled ack rule, and completion rule;
- Claude prompt forbids native `Task` delegation, Pi tools, Pi extensions, Pi child-control instructions, direct run-file mutation, and task mutation;
- inherited Pi-specific runtime includes are excluded with `excludedAcrossHarness` provenance;
- harness-neutral role content is preserved;
- long/sensitive task text lives in `task.md`, not argv;
- Pi prompt contract remains unchanged for Pi children.

### 4. Fake Claude oneshot runtime

Seam: fake `claude` executable invoked by the real supervisor with `--print --output-format stream-json`.

Must assert:

- oneshot v1 has no child-control MCP result producer; generated config is empty/strict as required to suppress ambient servers;
- stream-json final result writes exactly one `result.json` and terminal status;
- unknown/partial stream-json lines are handled without corrupting logs;
- duplicate final result events do not produce duplicate terminal wakeups;
- process exits before final result, nonzero exit, huge output, and secret-bearing stderr produce useful redacted failure results;
- sanitized recorded Claude stream-json fixtures are parsed so tests do not overfit to fake output;
- live inbox delivery after launch is reported unsupported for oneshot.

### 5. Fake Claude MCP conformance

Seam: fake Claude parses generated interactive `--mcp-config`, spawns the configured `async-subagents claude-child-mcp --run-dir ...`, and speaks MCP JSON-RPC over stdio.

The fake must not write async-subagents run files directly except its own stdout/stderr logs.

Must assert:

- newline-delimited MCP initialize/notifications/initialized/tools/list/tools/call framing works for Claude Code 2.1.197; optional Content-Length support is tested separately if implemented;
- `subagent_event`, `subagent_read_inbox`, `subagent_ack_inbox`, `subagent_complete`, `subagent_block`, and `subagent_liveness` mutate the run store only through the server;
- runDir outside root, symlinked runDir, non-canonical runDir, other runDir, lineage mismatch, invalid params, broken pipe, terminal-run mutation, and duplicate completion fail correctly;
- duplicate in-flight JSON-RPC ids are handled according to MCP/JSON-RPC expectations without corrupting state;
- broken pipe or server crash leaves no partial status/result mutation beyond fully committed events.

### 6. MCP mutation serialization and race lane

Seam: concurrent JSON-RPC calls against the real MCP server plus supervisor finalizer/process-exit hooks.

Must assert:

- N parallel `subagent_event` calls produce unique monotonic event sequence numbers;
- `subagent_complete` racing process exit yields exactly one result and one terminal wakeup;
- pause/cancel/timeout racing complete is deterministic and documented;
- stale budget generations cannot pause a continued run;
- supervisor process-close finalization observes existing MCP result and performs cleanup only;
- result file, terminal event, status state, and wakeup dedupe remain consistent.

### 7. Required tmux interactive transport lane

Because interactive tmux is the v1 default for Claude variants, at least one automated tmux-backed fake-Claude lane is required before merge in an environment with tmux installed.

Must assert:

- run-local tmux socket/session/pane is created;
- fake Claude launches through the real supervisor adapter from `subagent_start`, not an adapter-only helper;
- parent nudge is injected through the production tmux send path using the run-local socket/session;
- multi-line/special-character nudges are safely injected;
- fake Claude observes the nudge and then calls MCP `subagent_read_inbox`;
- handled acknowledgement is required for `requiresAck` default success;
- pause/resume/cancel operate on the intended process group/session;
- SIGTERM ignored leads to SIGKILL and cleanup warning if needed;
- child exits early, send failure, huge output, stale session/socket/pane, and cleanup failure are diagnosed;
- completion/cancel removes tmux sessions and MCP helpers;
- if tmux is unavailable, interactive launch fails pre-spawn with `TRANSPORT_UNAVAILABLE`; this fail-closed test is not a substitute for the required tmux lane.

### 8. Inbox acknowledgement matrix

Seam: real run store + fake interactive Claude/tmux + real MCP server + real `subagent_message`/`subagent_continue` tool handlers.

Must assert:

- `queued`, `injected`, `received`, `handled`, and `failed` states persist correctly;
- `requiresAck=true` defaults to `handled` and tool result does not succeed on terminal injection alone;
- explicit `ackLevel="received"` succeeds on read without handle and is clearly reported as received-only;
- `ackTimeoutSeconds` default and cap are enforced;
- delayed ack just under deadline succeeds;
- delayed ack after deadline records a late event but does not change the previous tool result;
- nudge delivered but no MCP read becomes delivery failure and may derive an `ack_failed` attention event;
- read with no handle, duplicate ack, rejected disposition, wrong message id, paused child, terminal-before-ack, and injection failure are deterministic;
- injection cursor and handled cursor advance only at the documented transitions;
- `subagent_continue` starts ack timers only after successful resume and injection;
- timeout warning messages use this same delivery state machine.

### 9. Liveness and reconciliation lane

Seam: supervisor-managed tmux fake Claude plus status recovery through real `subagent_status` with deterministic clock/short thresholds.

Must assert:

- normal idle after silence with no pending input;
- question/block becomes `waiting_for_input`;
- pending handled ack becomes `ack_pending`;
- post-nudge no-output/no-MCP becomes `comatose`;
- rate-limit output with parseable reset time becomes `rate_limited` and later resumes;
- `subagent_liveness` explicit signals update status;
- paused and terminal states dominate weaker liveness states;
- missing tmux session/socket/pane becomes `stale_transport`, not idle;
- supervisor dead + child/tmux alive becomes `orphaned_process`;
- process group missing before terminal result becomes failed unless terminal result raced and won;
- terminal run with helper/session alive triggers bounded cleanup and warning if cleanup fails;
- persisted status fields (`lastTerminalOutputAt`, `lastMcpCallAt`, `lastNudgeAt`, output bytes, pending ack ids) are updated.

### 10. Dangerous execution, normal auth, memory posture, and shell-home split lane

Seam: fake Claude invokes a Bash/tool subprocess through the generated wrapper and inspects generated Claude settings/execution-mode files.

Must assert:

- default `dangerous-auth` launches do not pass `--bare` and reach the same auth/budget gate as normal `claude`;
- generated settings include `permissions.defaultMode=bypassPermissions` and `skipDangerousModePermissionPrompt=true`;
- argv includes `--dangerously-skip-permissions` and TUI hand-test shows bypass mode starts without prompt;
- launch metadata records `memoryIsolation: "best-effort-non-bare"` and does not claim strict memory disabling;
- no project `CLAUDE.md`, ambient MCP config, hooks, plugins, or ambient skills are copied into run home unless explicitly configured and recorded;
- `--bare` probe remains documentary evidence only: it confirms OAuth/Max/keychain auth is not used and auto-memory/CLAUDE.md are disabled, but there is no v1 bare launch mode;
- Bash subprocess `HOME` is `<runDir>/shell-home`, not operator home, when the Claude tool runtime supports the split; if unsupported, metadata records `shellHomeIsolation: "unsupported"`;
- selected git/ssh/npm conveniences are copied only into shell-home when explicitly allowlisted;
- credential/env/path redaction appears in launch/status/result/failure card details.

### 11. Skill isolation lane

Seam: temp skill roots + fake Claude reading actual `$HOME/.claude/skills` from run-local home.

Must assert:

- requested Claude skill resolves to exactly one source with documented precedence;
- launch metadata/status/result record selected source, target, compatibility, and warnings;
- fake outputs sentinel only by reading copied skill content;
- path-like `skills` are rejected at `subagent_start` boundary;
- Pi-style `SKILL.md` directory skills work when copied into `.claude/skills/<name>/`;
- file-only skill requested by Claude fails pre-spawn;
- directory skill without `SKILL.md` fails;
- duplicate roots, symlink/path traversal/name collision/unreadable file/huge skill are handled as specified;
- ambient operator `.claude/skills` sentinel is not visible.

### 12. Pi wakeup message boundary lane

Seam: register `asyncSubagentsPiExtension` in a fake Pi context, trigger the real polling/session-start path, and inspect actual `sendMessage` payload/details.

Must assert:

- wakeup text includes `NOT USER INPUT`, harness, state/liveness, run identity, and recommended action when relevant;
- wakeup text excludes raw terminal transcript, full sensitive task text, and secrets;
- result and attention visible in the same poll deliver result only;
- question then completion before poll suppresses stale question;
- blocked then failed suppresses stale blocked event;
- duplicate terminal event plus result delivers once;
- stale lease retry does not duplicate semantic terminal wakeups;
- result body over cap is truncated with `subagent_result` recovery guidance;
- `ack_failed`, `comatose`, `stale_transport`, and `orphaned_process` produce actionable attention wakeups unless terminal result suppresses them.

### 13. Renderer width lane

Seam: actual renderer/component tests using Pi-provided render width/factory components.

Must assert:

- renderer never relies on `process.stdout.columns`;
- rows/cards remain coherent at widths around 120, 80, 60, and 44 columns;
- long display names, variants, tmux paths, skills, and execution-mode labels truncate/drop safely;
- failure cards for schema, skill, transport, permission, and auth errors use correct chrome and `renderShell: "self"`;
- rate-limit/comatose/ack-pending/ack-failed/stale-transport/orphan badges fit without breaking layout.

### 14. Timeout, budget, and task association lane

Seam: real supervisor timers/process group, real task store, fake Claude result/artifact paths.

Must assert:

- runtime budget warning goes through delivery state machine;
- pause/continue/cancel update durable budget fields and respect generation;
- cancel writes terminal cancelled result only if no result exists;
- timeout pause does not overwrite completed result;
- Claude child cannot mutate parent-owned tasks directly;
- parent can attach Claude result/evidence/artifacts to tasks through normal `task_update`;
- cancelled/failed associated runs remain recoverable by task/status/result tools.

## Scripted fake-Claude smoke

Manual smoke is optional observability only. Required fake-Claude smoke must be a bounded script:

```sh
npm run smoke:claude-harness --workspace @bravo/async-subagents
```

The script must:

- create a temp `ASYNC_SUBAGENTS_HOME` and disposable workspace;
- install fake `claude` earlier on `PATH`;
- create a Claude-compatible sentinel skill;
- drive `subagent_start`, `subagent_message`, `subagent_continue`, `subagent_status`, and `subagent_result` through real Pi extension/tool handlers;
- trigger the real wakeup polling/session-start path when asserting wakeups;
- exercise oneshot, interactive Q/A, timeout/continue, cancel, skill failure, schema failure, permission/auth failure, liveness/rate-limit/comatose, stale tmux cleanup, and task association;
- assert JSON files, tool results, wakeup message content, output files, and process cleanup;
- use explicit timeouts for every process and tmux operation;
- exit nonzero on failure;
- archive redacted logs on failure.

A separate noninteractive CLI harness is acceptable only when it calls the same implementation functions as the Pi extension boundary being claimed.

## Optional visual TUI smoke

After automated fake-Claude smoke passes, an operator may run a tmux-attached Pi session to visually inspect cards/widgets:

- use isolated `ASYNC_SUBAGENTS_HOME`;
- fake Claude first, live Claude only if auth preflight succeeds;
- resize pane to widths 120/80/60/44;
- verify cards are readable and no chrome breaks.

This visual smoke is not a merge gate and cannot substitute for scripted fake/MCP/tmux tests.

## Optional live Claude smoke

Run only after deterministic local seams pass and local Claude auth is configured.

Must be bounded and record:

- `claude --version`;
- selected `--mcp-config` form accepted by installed Claude;
- selected auth backend and execution mode support;
- redacted launch log;
- stderr tail on failure;
- whether failure happened before spawn, during Claude startup, MCP exchange, or task execution.

Live smoke may be skipped with precise environment reason. It is not normal CI proof.

## Runtime invariants table

| Boundary | Invariant | Faithful seam | Injected faults |
|---|---|---|---|
| Definition parsing / variant resolution | Claude variant resolves deterministically; Pi-only execution fields are either non-inherited with provenance or explicit pre-spawn failures. | Real markdown parser over temp builtin/user/project definitions through `startSubagent()`. | Unknown harness; explicit Claude tools/extensions/thinkingLevel; base Pi tools/extensions; default/inherited Pi extensions. |
| Parent prompt/catalog/tool surfaces | Parent prompt and catalog teach harness-aware orchestration and do not infer Claude capabilities from Pi base tools. | Render/register real Pi extension prompt/catalog/tool schema functions. | Mixed Pi/Claude variants; path-like skills; `thinkingLevel` on Claude; repeated prompt injection replacement. |
| Claude child prompt assembly | Claude prompt contains lifecycle/MCP contract and excludes Pi runtime instructions; task text is artifact-backed, not argv-backed. | Real prompt assembly writing `system.md`/`task.md`. | Pi include inherited; missing child contract; long/secret task; forbidden `Task` guidance absent. |
| Claude command construction | Command uses constant CLI prompt, system prompt file, strict MCP config by mode, disallowed Task, selected model/effort/execution mode, explicit auth-home metadata, and redacted logs. | Real `startSubagent()` + fake executable records argv/env. | Missing binary; malformed effort/model/execution mode; secret env; unsupported field; task text sentinel; unexpected `--bare` in default mode. |
| MCP containment | MCP server only mutates canonical matching run through generated stdio process; no per-call auth claim in v1. | Real MCP stdio server spawned from generated config. | Symlink runDir; other runDir; lineage mismatch; terminal run mutation; invalid params. |
| MCP mutation serialization | Events/status/inbox/result changes are per-run serialized; terminal result at most once. | Concurrent JSON-RPC calls against real MCP server and supervisor finalizer. | Parallel events; complete racing process exit; pause/cancel racing complete; duplicate complete. |
| Interactive tmux transport | Claude process gets addressable terminal; nudges, pause/resume/cancel, cleanup use production paths. | Real tmux-backed fake Claude in automated lane. | tmux unavailable; send failure; stale session; huge output; child exits early; SIGTERM ignored; cleanup failure. |
| Inbox delivery | Parent message success is not terminal injection; handled ack is default for `requiresAck`. | Real inbox + tmux nudge + MCP read/ack + real tool result. | No read; read no handle; wrong id; duplicate/rejected ack; delayed ack; terminal-before-ack. |
| Liveness | Alive-but-unhealthy states are distinguished from running/idle with deterministic thresholds. | Supervisor/tmux fake Claude with output/MCP/probe controls and deterministic clock. | silence; post-nudge comatose; rate limit; missing tmux; orphan child/helper; paused/terminal precedence. |
| Timeout/budget | Budget expiry warning, pause, continue, cancel are durable and race-safe. | Real supervisor timers/process group with fake Claude. | stale timer generation; complete during timeout; SIGTERM ignored; paused child message. |
| Auth and shell-home split | Default mode uses working normal Claude auth and records whether auth came from seeded run-home or operator-home; Bash shell-home isolation is attempted and truthfully reported. | Fake Claude invokes generated Bash wrapper and probes sentinels; live smoke verifies normal auth reaches budget gate. | missing auth; run-home credential sentinel; symlink target; env credential; unsupported shell-home split; unapproved `.ssh`/npm/cloud creds. |
| Dangerous execution / memory posture | Claude launches in dangerous bypass with normal auth by default; memory isolation is best-effort non-bare and must not be overclaimed. | Generated settings/argv inspection plus auth/model/bare probes and tmux startup hand-test. | default uses `--bare`; dangerous flag omitted; prompt not skipped; memoryIsolation mislabeled. |
| Skill resolution/install | Requested skill resolves to exactly one directory containing `SKILL.md` and is copied into run-local Claude home. | Temp skill roots + live/fake Claude invokes `/skill-name` from `$HOME/.claude/skills`. | file-only skill; dir without `SKILL.md`; path-like skill; symlink escape; duplicate root; ambient skill sentinel. |
| Wakeup boundary | Real Pi sent messages are runtime envelopes with harness/liveness and no raw transcript/secrets. | Fake Pi extension context at `sendMessage` boundary through real polling/session-start. | result+attention same poll; duplicate terminal events; body over cap; stale lease retry; stale attention. |
| TUI rendering | Rows/cards are width-stable and expose actionable Claude states. | Real renderer tests with width control. | 44-col width; long paths/names; failure cards; liveness badges. |
| Task association | Claude child cannot mutate tasks directly; parent attaches evidence from result paths. | Real task store + fake Claude result/artifacts. | child attempts parent-only task tool; cancelled associated run; dependency incomplete. |

## Definition of done

Done means the real code path for every invariant above has executed green against its faithful seam, including at least one injected fault.

Required:

- `npm run check --workspace @bravo/async-subagents` passes.
- `npm test --workspace @bravo/async-subagents` passes.
- Required fake-Claude scripted smoke passes.
- Required tmux interactive lane passes in CI or equivalent merge-gating environment.
- No test requires live Claude credentials for normal CI.
- Parent prompt module, tool schemas/descriptions, agent catalog, wakeup envelopes, child prompt contract, and TUI/read-model surfaces are updated and tested at the real boundaries.
- Claude skill success/failure paths are visible in launch metadata and tests.
- Credential/auth material and shell-home isolation are truthfully recorded; no implementation claims strict isolation when the selected normal-auth path cannot provide it.
- No orphan tmux sessions/process groups/MCP helpers remain after completion/cancel; cleanup failures are surfaced.
- Live Claude smoke either passes or is skipped with precise environment reason; it is optional and not primary proof.
