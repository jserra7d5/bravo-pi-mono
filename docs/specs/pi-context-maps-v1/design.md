# Pi Context Maps v1

## Status

Draft design, revised after GPT/Gemini harness-engineering critique.

## Problem

Pi has good primitives for direct source inspection (`read`, `grep`, `bash`) and ranked lexical discovery (`ranked_search`). The async-subagents package also provides durable child-agent execution and result handoff. What is missing is a small, reusable context-routing layer for broad code/docs investigations:

- agents need help finding the load-bearing files and sections without flooding the main context window;
- child/scout agents need a durable artifact format richer than a prose handoff but lighter than dumping all source text;
- parent agents need to selectively materialize source truth before synthesizing conclusions;
- search hits alone are too low-level, while subagent summaries alone are too lossy.

ROGER's retrieval tools demonstrate the useful pattern: a bounded retrieval pass returns compact routing information plus citations/handles, and exact context is read separately before it is relied on.

## Design Principle

Context Maps are a **context presentation primitive**, not a final-answer primitive.

A context map should answer:

> Where is the load-bearing context, what shape does it have, and what should the parent read next?

It should not answer:

> What is the final conclusion?

The parent agent remains accountable for synthesis. The context-map tool provides an orientation brief and durable source handles.

## Non-Goals

- Do not merge this into `packages/async-subagents` as core process orchestration.
- Do not replace `ranked_search`; consume it as one retrieval backend.
- Do not create a giant summarized grep dump.
- Do not make map output a substitute for reading source text when exact claims matter.
- Do not remove `bash` from scout/retrieval lanes; constrain how it is used.
- Do not make `context_map_create` secretly spawn child agents in v1.
- Do not support cross-session/global map reuse in v1.

## Proposed Package Boundary

Introduce a separate Pi package, tentatively:

```text
packages/context-maps/
```

or distributed as:

```text
@bravo/context-maps
```

It should sit above Source Search and beside Async Subagents:

```text
ranked_search / grep / read / safe bash orientation
        │
        ▼
context_map_create
        │
        ├─ durable map artifact
        ▼
context_map_read
```

`source-search` remains the lexical discovery/indexing substrate. `async-subagents` remains the process/task orchestration substrate. Context Maps provide the durable retrieval artifact and read/materialization surface.

In v1, subagents may call `context_map_create`, but `context_map_create` itself should stay single-turn and bounded: asynchronous at the TypeScript `execute()` level, but not a background job and not a hidden child-agent spawn. If child-agent-backed map creation is needed later, expose it deliberately rather than hiding orchestration inside a read-like tool.

Child availability is not automatic through Pi project auto-discovery because async-subagents launches children with project extension auto-discovery disabled. In v1, async-subagents should receive Context Maps through explicit `defaultExtensions` configuration with an absolute approved path. It must not auto-approve arbitrary project-local lookalike paths. Project-local context-map extensions still require explicit user configuration/approval.

## Tool Choice Policy

The package should ship a compact prompt module with explicit decision boundaries:

1. **Named file/path or small known section** → use `read`/`grep` directly.
2. **Narrow lexical lookup across unknown files** → use `ranked_search` first.
3. **Broad, ambiguous, cross-surface, or handoff-oriented discovery** → use `context_map_create`.
4. **Long-running or judgment-heavy retrieval** → start a scout/child agent; the scout may create a context map and return its `map_id`.
5. **Exact claim or citation** → use `context_map_read` or direct `read` on the relevant source before relying on it.

Anti-patterns:

- Do not call `context_map_create` just to inspect a named file.
- Do not use map orientation text as evidence.
- Do not call `context_map_read` on every slice by default.
- Do not use `bash` to dump source text when dedicated read/search tools are available.

## Tool Surface

Keep the native tool surface small.

### `context_map_create`

Creates a durable map for a broad or ambiguous repository/docs question.

Use when:

- the agent needs to orient across a large code/docs surface;
- the relevant files are not already known;
- a child/scout result should be handed off as structured context;
- the parent needs source handles for later selective reading.

Avoid when:

- the user named a specific file or small known section;
- a direct `read` or `ranked_search` query is sufficient;
- the agent already has the source text required for the next decision.

Suggested parameters:

```ts
{
  query: string;
  roots?: string[];
  max_slices?: number;
  seed?: ContextRef[];
  exclude?: ContextRef[];
}
```

The v1 implementation should be single-turn and bounded. It will still be asynchronous in TypeScript because Pi tool `execute()` handlers and Source Search sidecar calls return promises. It may use Source Search, policy-filtered direct file reads, and constrained bash orientation. It should not spawn an internal child process in v1.

### `context_map_read`

Materializes selected slices from a durable map.

Use when:

- the parent needs exact source text;
- a claim depends on a cited file section;
- a downstream agent needs selected context without re-running discovery.

Suggested v1 parameters:

```ts
{
  map_id: string;
  slice_ids: Array<string | number>;
}
```

No `refs` parameter in v1: arbitrary refs duplicate `read` and blur the tool boundary. No `mode: "all"` in v1: broad materialization undermines the context-budget purpose. A later `load_bearing: true` shortcut may be added if evals show it improves behavior without causing over-reading.

Suggested output:

```json
{
  "map_id": "ctx_abc123",
  "slices": [
    {
      "slice_id": 3,
      "ref": {
        "path": "packages/async-subagents/extensions/pi/tools.ts",
        "start_line": 620,
        "end_line": 820
      },
      "content": "...exact materialized source text...",
      "truncated": false
    }
  ],
  "truncated": false,
  "warnings": []
}
```

Every returned block must preserve exact path and line metadata. The tool should enforce per-slice and cumulative output limits and return truncation metadata rather than flooding context.

### Later, Only If Needed

- `context_map_extend(map_id, query, seed?, exclude?)`
- `context_map_list()`
- `context_map_delete(map_id)`

Do not expose these until real workflows prove they are needed.

## Output Contract

`context_map_create` should return an **orientation brief**, not a final summary.

Example shape:

```json
{
  "map_id": "ctx_abc123",
  "evidence_status": "orientation_only_requires_context_map_read",
  "orientation": {
    "routing_summary": "Two relevant surfaces were found: async-subagents orchestration and source-search lexical discovery.",
    "load_bearing_refs": [
      {
        "slice_id": 3,
        "ref": {
          "path": "packages/async-subagents/extensions/pi/tools.ts",
          "start_line": 620,
          "end_line": 820
        },
        "role": "primary",
        "why": "parent tools for subagent lifecycle and result handoff",
        "confidence": "high",
        "preview": "subagent_start / subagent_result tool registration and execution handlers"
      },
      {
        "slice_id": 7,
        "ref": {
          "path": "packages/source-search/extensions/pi/index.ts",
          "start_line": 33,
          "end_line": 109
        },
        "role": "primary",
        "why": "ranked_search tool registration and execution path",
        "confidence": "high",
        "preview": "buildSourceSearchTools registers ranked_search and invokes queryRepo"
      }
    ],
    "suggested_read_order": [3, 7, 9],
    "gaps": ["Did not inspect upstream Pi core internals."],
    "coverage": {
      "searched_roots": ["packages/async-subagents", "packages/source-search"],
      "searched_methods": ["ranked_search", "read"],
      "excluded_roots": [],
      "failed_roots": [],
      "confidence": "medium"
    }
  }
}
```

Field semantics:

- `map_id`: durable handle for later reads.
- `evidence_status`: explicit warning that the map is orientation, not evidence.
- `routing_summary`: compact operational orientation, not synthesis.
- `load_bearing_refs`: the small set of source sections most likely to matter.
- `ref`: structured path and line range.
- `role`: `primary`, `supporting`, `background`, or `negative-space`.
- `confidence`: retrieval confidence for that slice or coverage claim.
- `preview`: short lexical grounding only; not enough source content to support exact claims.
- `suggested_read_order`: what the parent should materialize first.
- `gaps`: explicit uncertainty and unsearched surfaces.
- `coverage`: what the retrieval pass actually touched.

Forbidden output behavior for `context_map_create`:

- no final user-facing answer prose;
- no architectural conclusions beyond routing-level orientation;
- no recommendations except read order or follow-up retrieval/read targets;
- no claims that require source truth unless backed by a slice handle and marked for reading;
- no large snippets or full source blocks.

The orientation brief should add routing value and avoid duplicating the map contents. The parent agent writes the real synthesis after reading selected slices.

## Durable Artifact Shape and Lifecycle

V1 maps should be workspace-local and run-addressable, not hidden under an unresolvable child-only session path. Parent and child agents are separate Pi processes; a parent receiving only `map_id` from a child must still be able to resolve the artifact.

Preferred storage:

```text
.pi/state/context-maps/<map_id>.json
```

`map_id` should be globally unique within the workspace and include enough prefix information to avoid collisions, for example `ctx_<root-or-run-id>_<nonce>`. When async-subagents is present, the store should record `ASYNC_SUBAGENTS_ROOT_SESSION_ID`, `ASYNC_SUBAGENTS_PARENT_RUN_ID`, and child run id if available, but `context_map_read` should not require the caller to separately provide those ids.

Do not use an agent-global cache in v1. Cross-session reuse/export requires a separate invalidation strategy.

A persisted map should include:

- schema version;
- map id;
- query;
- workspace root;
- git commit if available;
- dirty-state marker;
- created timestamp;
- package/tool version;
- retrieval method/backends used;
- retrieval provenance events;
- coverage/gaps;
- slice table with structured path, line range, score/reason, role, confidence, and optional short preview;
- load-bearing slice IDs;
- materialized read history, if useful for debugging.

Map IDs are valid only for the workspace state recorded in the artifact. If the working tree or branch changes after map creation, `context_map_read` should warn or invalidate depending on severity. If a map was created by a child process, the parent must be able to resolve it using only the returned `map_id`.

Do not persist large full-file bodies in the map by default. Store handles and previews; materialize exact text through `context_map_read`.

Retention:

- keep session/run maps with the session by default;
- optionally garbage-collect orphaned maps older than a configurable TTL;
- never silently delete maps referenced by current task receipts or active child runs.

## Security and Privacy

Context maps may expose sensitive paths, filenames, snippets, branch names, or proprietary architecture. V1 must:

- obey the same ignore/security policy as Source Search for every surfaced file or slice;
- never surface ignored files in v1;
- skip or redact likely secrets (`.env`, keys, tokens, credentials, PEM material);
- cap previews aggressively;
- avoid persisting large source bodies;
- store artifacts under workspace/session state with normal user-only permissions where practical;
- distinguish redacted/ignored coverage gaps from true no-result gaps.

Important implementation constraint: Source Search's current ignore and hard-deny behavior lives in the Rust sidecar. Context Maps must not bypass that policy when doing TypeScript-side materialization or fallback reads. Phase 0 must either expose a Source Search policy adapter or replicate the policy in TypeScript for all paths that Context Maps reads, previews, persists, or returns.

## Bash Policy

Retrieval/scout lanes should keep `bash`, but source consumption should be constrained.

Policy:

```text
Bash is for orientation, metadata, git state, filesystem shape, and safe shell probes.
Substantive source reading and citation should flow through ranked_search, read, grep, or context_map_read.
```

Allowed bash examples:

- `pwd`
- `git status --short`
- `git branch --show-current`
- `git ls-files`
- `find ... -maxdepth ...`
- `ls`
- `wc -l`
- safe metadata commands

Discouraged for substantive source reading:

- `cat file`
- `sed -n ... file`
- `awk ... file`
- Python scripts that dump source text

This should be a behavioral contract first. Enforcement can be added later through bash interception if misuse recurs. V1 should at least record retrieval provenance events such as:

```ts
{
  backend: "ranked_search" | "read" | "grep" | "bash";
  query_or_command?: string;
  command_class?: "filesystem_metadata" | "git_metadata" | "source_dump" | "unknown";
  result_count?: number;
}
```

This makes bash misuse auditable even before hard blocking exists.

## Prompt / Context Presentation

The prompt should carry only a compact navigation policy, for example:

```text
For broad code or documentation discovery, prefer context_map_create.
Treat returned maps as orientation and source handles, not final evidence.
Use context_map_read on selected load-bearing slices before relying on exact claims.
Use direct read/ranked_search when the target file or query is already narrow.
```

Do not push the full context-map methodology into every agent prompt. The package should ship a tool-coupled prompt module that is included only when the tools are enabled.

## Async Subagent Integration

Async subagents should be able to produce and consume context maps without owning the feature.

Possible handoff pattern:

```text
parent starts scout
  scout runs context_map_create
  scout result returns map_id + orientation
parent reads selected slices with context_map_read
parent synthesizes
```

Task receipts may reference `context_map:<map_id>` instead of embedding large prose or source excerpts. Downstream agents can read the same selected slices without repeating discovery.

This keeps async-subagents focused on durable process orchestration while giving it a better artifact vocabulary.

## Source Search Integration

`ranked_search` is the likely default retrieval backend for code/docs discovery because it already provides:

- repo/workspace discovery;
- indexed search with live fallback;
- path and filename weighting;
- snippet windows;
- ignore/security policy;
- multi-repo workspace support.

Context Maps should call Source Search internally where possible and convert ranked hits into durable slices plus orientation. Source Search should not become responsible for parent-agent synthesis or subagent handoff.

Context Maps should use the small Source Search backend API exported for package consumers rather than importing Pi-extension internals.

## Error Semantics

Errors should teach recovery:

- `ContextError`: workspace/session state is missing; do not retry blindly.
- `ToolExecutionError`: invalid path, unknown map id, invalid slice id; fix arguments.
- `AdapterError`: search backend/index failed; retry once, fallback to live scan/direct tools, or report degraded coverage.

Never return an empty map for a permission/config/backend failure. Empty results should mean the searched scope produced no relevant matches. Redaction, ignored paths, and failed roots should appear as coverage gaps or warnings.

## Behavioral Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Tool orientation competes with parent synthesis | Return routing orientation only; forbid final-answer language |
| Map becomes too broad | Cap load-bearing refs; include suggested read order; omit `read all` in v1 |
| Parent trusts map without reading | `evidence_status`; prompt/tool docs; evals requiring read before exact claims |
| Scout dumps full context | Persist handles/previews; materialize through read tool |
| Bash bypasses evidence tools | Bash policy, provenance recording, future interception if misuse recurs |
| Tool surface grows too large | Start with create/read only |
| Context-map package duplicates source-search | Treat source-search as backend, not sibling replacement |
| Async-subagents becomes bloated | Integrate by artifact reference only |
| Stale maps mislead agents | Session-local storage; git commit/dirty markers; warnings/invalidation |
| Sensitive snippets leak into artifacts | Source-search ignore policy, redaction, capped previews |
| Backend failure looks like no results | Typed error semantics and explicit coverage failures |

## Validation Plan

Add eval-style tests around agent/tool behavior, not just unit tests:

1. Broad repo question returns an orientation brief with map id, load-bearing refs, gaps, and coverage.
2. Orientation does not attempt final synthesis or use user-facing answer language.
3. `context_map_read` materializes exact selected slices with structured paths and line ranges.
4. Parent-agent prompt guidance causes selected reads before exact claims.
5. Retrieval lane uses bash for orientation but cites only dedicated read/search/map-read outputs.
6. Source Search fallback path still produces usable maps when no index exists.
7. Unknown map/slice IDs produce recoverable argument errors.
8. Named-file tasks prefer direct `read`/`grep`, not `context_map_create`.
9. Broad ambiguous tasks prefer `context_map_create` over repeated ad hoc grep/read loops.
10. Parent must not cite map orientation as evidence.
11. Stale/dirty workspace maps warn or invalidate.
12. Backend failure is distinguishable from true no results.
13. Ignored/secret files are not surfaced; redactions are reported as coverage gaps.
14. Ambiguous or failed roots produce explicit coverage gaps.
15. `context_map_read` enforces cumulative output limits and reports truncation.

## Implementation Plan

### Phase 0: Contract Spike

- Define TypeScript types for `ContextMapArtifact`, `ContextSlice`, `ContextMapCreateResult`, and `ContextMapReadResult`.
- Decide exact workspace-local state path helper and map-id format; parent must resolve child-created maps using only `map_id`.
- Define output size limits and truncation behavior.
- Define git commit/dirty-state probes; Source Search responses do not currently supply this metadata.
- Define or implement the security/ignore policy adapter required for every surfaced path.

### Phase 1: Minimal Package and Storage

- Create `packages/context-maps` workspace.
- Implement artifact store with session/run-local storage.
- Implement schema validation and versioning.
- Implement map read/materialization from stored slice refs.
- Add unit tests for store, validation, truncation, and stale workspace metadata.

### Phase 2: Source Search Backend

- Add or use a documented Source Search backend API/adapter; avoid brittle imports from package-internal files.
- Reuse Source Search query behavior where possible.
- Convert ranked hits/snippets into context slices.
- Generate routing orientation from ranked results without final synthesis.
- Record provenance events and coverage.
- Add tests for indexed and live-fallback search paths.

### Phase 3: Pi Extension Surface

- Register `context_map_create` and `context_map_read` native tools from `packages/context-maps/extensions/pi/index.ts` using the standard Pi extension pattern.
- Add package `pi.extensions` metadata so normal Pi sessions can auto-discover the extension.
- Ship a compact tool-coupled prompt module with the tool-choice policy.
- Add custom rendering only if needed for readability; otherwise keep plain structured output.
- Add package README and usage examples.

### Phase 4: Async Subagent Handoff

- Document how scouts/workers return `context_map:<map_id>` in result bodies, task receipts, or artifact metadata. Implemented in `packages/context-maps/README.md` and the packaged scout prompt.
- Ensure map paths are reachable from child and parent processes in the same workspace, and that `context_map_read` resolves a child-created map from only `map_id`. Implemented by workspace-root storage under `.pi/state/context-maps/<map_id>.json`.
- Document that async-subagent child processes need the context-maps extension forwarded because child launches disable extension auto-discovery; default forwarding should use explicit `defaultExtensions` configuration with an absolute approved path. Implemented in `packages/context-maps/README.md`.
- Add an example scout handoff flow. Implemented in `packages/context-maps/README.md`.
- Remaining: add richer end-to-end behavioral evals before treating the tool-selection policy as proven.

### Phase 5: Behavioral Evals

- Build small eval fixtures for named-file, narrow-search, broad-search, stale-map, and secret-file cases.
- Validate that agents choose the right tool path and read materialized slices before exact claims.
- Measure bash source-dump misuse before deciding whether to add hard interception.

## Open Questions

- What exact Pi session/run identifier should key v1 map storage?
- Should `slice_id` be numeric, string, or stable content-derived? Numeric is simpler; content-derived improves stale detection.
- How much preview belongs in the map before it becomes source material rather than an index?
- Should a later `load_bearing: true` shortcut be added to `context_map_read`?
- Should bash policy be enforced in the tool runner or left as prompt-level behavior until misuse is observed?
