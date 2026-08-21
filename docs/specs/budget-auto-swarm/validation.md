# Validation

## Completion standard

Green unit tests alone are insufficient. Done means the real Pi extension entrypoint and real async-subagents start path exercised the mode’s state, exact prompt rendering, launch guard, task coupling, and install behavior against temp sessions/filesystems. Prompt/model behavioral evals are explicitly prohibited and are not a release gate.

## Invariant matrix

| Boundary | Runtime invariant | Faithful seam | Fault / edge case | Required evidence |
|---|---|---|---|---|
| Command → sticky state | A valid state change appends exactly one branch entry; idempotent/status/invalid commands append none. | Load the real TypeScript Pi extension entrypoint in the existing host test harness with a real `SessionManager` temp session. | Empty/on/off/status, invalid arg, repeated on/off. | Session entries plus command notifications/status calls. |
| Global session/process restore | The user-global state determines desired mode across new sessions, branches, reloads, and independent Pi processes; only successfully reconciled state is published. Historical transcript markers are inert. | Real source extension loaded with Pi `DefaultResourceLoader` and real temp `SessionManager` instances plus a subprocess reading the same temporary `ASYNC_SUBAGENTS_HOME`. | New session, fork/tree navigation with conflicting legacy markers, reload/resume, malformed global state, task/tool reconciliation failure. | Global file state versus published runtime/prompt/guard/badge state in each runtime. |
| Task coupling | Published budget mode always has task tools/state enabled; activation/restore failures publish budget disabled while preserving durable desired state for retry. | Real extension entrypoint loaded through Pi’s source loader with a real `SessionManager`, active-tool host, and temp task root. | Tasks initially off; task-store failure; `getActiveTools`/`setActiveTools` failure on command/start/tree; attempt `/tasks off`; mode off leaves tasks on. | Stored markers, published runtime state, prompt/guard state, active tools, badges, errors. |
| Prompt injection | Enabled prompt contains one exact overlay and one compact state line, removes conflicting base thinking/fast-track rules, and renders armed fast-track unavailable; disabled prompt is byte-compatible with current guidance. | Real source extension loaded through Pi’s host loader; invoke actual `before_agent_start`. | Repeated turns, stale markers, fast-track on/off, toggle on/off, compaction/resume. | Exact rendered prompt checked structurally and shown verbatim once in review evidence. |
| Catalog/variant resolution | Each built-in role exposes pure `luna` and `sol` overlays while preserving role body/tools/extensions. | Real `discoverAgentDefinitions()` and `applyAgentVariant()` over shipped files. | User/project role override; missing variant; project `luna` name mapped to wrong model. | Resolved definitions and catalog render. |
| Launch policy | Every allowed Pi-harness model/effort pair starts; every forbidden pair fails at the single `startSubagent` pre-allocation policy hook before any run/task/process side effect. | Load the real extension, call the real `subagent_start` tool through real `startSubagent`, and use real temp run/task stores with only spawn/preflight ports instrumented. | No variant, Claude harness, Gemini, Luna low/medium, Sol high/xhigh/max, Terra/custom model, `fastTrack: true`, project spoofed variant. | Typed error plus proof that run index/directory/task state/preflight/spawn remain absent. |
| Mode-off compatibility | Existing default, Gemini, and fast-track behavior remains unchanged when budget mode is disabled. | Existing start/fast-track integration tests with mode false. | Armed/disarmed fast-track, default role, Gemini provider. | Current test suite plus targeted mode-off cases. |
| Continuation | Existing recorded run continues with original launch identity; mode does not mutate it. | Real continuation preparation over recorded temp run metadata. | Pre-mode Sol/Gemini/fast-track run continued while mode enabled. | Continuation command/metadata and no policy rewrite. |
| Normal priority | No compliant budget start injects child-fast-track or priority service tier. | Inspect real generated Pi command, extension list, and launch metadata. | Fast-track globally armed but request omitted; explicit forbidden request. | `fastTrack.applied !== true`, no child-fast-track extension. |
| Compaction continuity | Active mode and task/run state reappear after compaction without policy duplication; a task-only ready/nonterminal graph emits a reminder even with no run rows. | Real extension/session compaction hook with real temp `TaskStore` and `RunStore`. | Active child, unread result, ready task/no run, waiting tasks/no run, no reminder-worthy work, mode toggled off before compact. | Reminder content/details and next-turn prompt. |
| Badge | Enabled shows exactly one lavender `SWARM:auto`; disabled clears; unchanged refresh does not call status again. | UI spy around real command/session handlers; ANSI-visible-width check. | New UI instance, branch switch, narrow host width, theme invalidation if relevant. | Call sequence and exact visible text/color. |
| CLI run storage | Child worktree cwd does not split run/start/watch/result visibility; Claude native Tasks remain the sole Claude graph owner. | Run the real CLI subprocess against a temp canonical checkout plus two real git worktrees and one combined real `watch`. | Two `start`s plus one synchronous `run` with the same root/store cwd and distinct execution cwd. | Every run is visible to combined watch, `run` start and wait both resolve canonical storage, no run artifacts appear under worktree-scoped default roots, and no async-subagents CLI task surface exists. |
| Claude install | Installer preflights launcher and both skills before mutation, creates missing parents, links idempotently, and honors conflict/force rules without altering healthy links on later failure. | Run real CLI subprocess for fresh/normal/conflict/idempotent cases; call the same production installer apply function with only its filesystem mutation port injected for deterministic directory/link operation failure. | Absent parent directories, healthy/stale symlink, first/second/third real-path conflict, `--force`, injected `ensureDir` or later symlink/rename failure. | Per-path JSON/results and exact before/after filesystem targets/directories. |
| Claude skill contract | Installed skill is discoverable, parses through the installed Claude Code skill loader when a non-model parser/listing seam is available, and contains the exact model/effort/user-invocation contract. | Real installer plus Claude Code’s local discovery/parser surface; otherwise the shipped file is validated structurally against the documented schema without invoking a model. | Unsupported frontmatter, conflicting destination, missing runtime skill link, organization may block Opus 5. | Discovery/parser output where available, exact installed bytes, settings file unchanged. No model-behavior assertion. |
| Prompt separation | The exact lead overlay is present only when enabled; child prompts never inherit it; UI text is never used as policy. | Real prompt assembly and child artifact generation with exact string/property assertions. | Toggle off, stale markers, compaction, child launch, badge render failure. | Rendered lead and child prompt artifacts plus marker counts. |

## Deterministic tests

### State and command tests

Add focused tests under `packages/async-subagents/test/`:

```text
budgetAutoSwarmState.test.ts
budgetAutoSwarmPrompt.test.ts
budgetLaunchPolicy.test.ts
budgetAutoSwarmInstall.test.ts
budgetAutoSwarmBadge.test.ts
```

Prefer extending existing host/task/prompt/installer suites when that exercises more of the real entrypoint and avoids a parallel fake harness.

Properties:

- missing global state defaults disabled and malformed/unsupported global state fails closed with an error;
- `on,on,status` performs at most one effective global enabled write;
- `off,off,status` performs at most one effective global disabled write after enable;
- a fresh controller and independent process restore the same global value without session entries;
- an already-running controller observes another process's change before its next lead turn;
- prompt transform is idempotent for any input containing zero, one, or stale duplicate marker blocks;
- accepted launch matrix equals the table in `contracts.md`, including Pi-only harness;
- every rejected launch has zero allocation/index/preflight/spawn/task mutation;
- mode false is behaviorally identical to the pre-feature path.

### Prompt fixture tests

Do not lock the entire large system prompt as a golden snapshot. Assert supported contracts:

- marker count;
- canonical heading order;
- exact budget overlay body sourced from one exported constant/file;
- enabled/disabled conditional presence;
- compact state line;
- no budget text in child `system.md` or `task.md` unless explicitly supplied by the parent task itself;
- no duplication of generic async-subagent instructions.

The production prompt string shown in `prompting.md` should be materialized from the same source file/constant the extension uses, or a test should compare it byte-for-byte to prevent doc drift. If direct transclusion is not practical, use a small script/check that extracts the marked spec code block and compares it to the exported prompt.

## Prompt verification boundary

No prompt evals, scripted-model tests, repeated model runs, behavioral scorecards, or model-judged rubrics are allowed for this feature.

Verification is limited to deterministic facts owned by the harness:

- exact bytes and section ordering of the Pi overlay and Claude skill;
- enabled/disabled/compaction placement;
- absence from child prompts;
- consistency between model-visible route text and the deterministic launch matrix;
- independent human/subagent audit of the static spec and rendered prompt for contradictions, duplication, and missing contracts.

These checks prove what the harness presents and enforces. They do not claim to prove that a probabilistic lead will always parallelize optimally. Throughput quality remains an operator-observed property during normal use; a future deterministic scheduler requires a separate design and user approval.

## Fault injection

Required deterministic faults:

- task-runtime or active-tool application throws during mode enable, session start, and tree navigation;
- status renderer throws/receives no UI;
- model preflight would be called, but the pre-allocation policy rejects first;
- supervisor spawn counter proves zero on rejection;
- run index write counter proves zero on rejection;
- project role shadows a built-in and spoofs variant names;
- stale duplicate prompt markers;
- malformed global state and conflicting historical branch markers;
- compaction with a ready task and no run rows, plus result-ready and blocked rows;
- each installer destination contains a real user-authored path in turn; an injected later mutation fails after preflight;
- Claude organization blocks `claude-opus-5` (documented invocation limitation, not installer behavior).

## Commands

During implementation, run the smallest relevant gates after each increment, then the package and repo gates:

```sh
npm run check --workspace @bravo/async-subagents
npm test --workspace @bravo/async-subagents
npm run check
npm test --workspaces --if-present
npm run build
pi list
```

The final release gate follows repository policy:

```sh
npm run check && npm test --workspaces --if-present
```

Manual TUI evidence in an interactive Pi session:

```text
/budget-auto-swarm status
/budget-auto-swarm on
/tasks off
/budget-auto-swarm off
/tasks off
```

Observe:

- lavender `SWARM:auto` appears once on enable and restores after `/reload`/resume;
- `/tasks off` is rejected only while mode is enabled;
- badge clears on disable;
- no duplicate status or widget appears;
- a forbidden launch is rejected with corrective allowed routes;
- a compliant Luna-high launch runs at normal priority.

## Required release evidence

The implementation PR must include:

- changed-file list and frozen diff/commit for review;
- full package check/test command output;
- focused state/prompt/launch/installer test output;
- one rendered Pi lead system prompt block exactly as the agent received it;
- the installed Claude `SKILL.md` exactly as Claude received it;
- launch metadata for one Luna-high and one Sol-medium compliant run;
- proof that a forbidden fast-track or Claude-harness request created no run directory/index entry;
- cross-worktree proof that CLI run surfaces start/run/watch through the same canonical store;
- independent static audit findings and closure dispositions for the spec and rendered prompts;
- manual TUI capture or operator notes for the purple badge and restore behavior.

## Release rollback

Rollback is code/package rollback plus `/budget-auto-swarm off` for any active session. Existing child runs and tasks remain valid and inspectable because the feature introduces no new run/task storage format. Before rollback, disable the mode in sessions where its launch guard would otherwise remain loaded until extension reload.
