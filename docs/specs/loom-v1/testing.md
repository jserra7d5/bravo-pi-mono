# Loom v1 Testing Contract

Status: draft contract  
Date: 2026-04-24

This document defines the testing expectations for Loom v1. The goal is to make Loom safe to implement incrementally while protecting the durable contracts in `contracts.md` and operational behavior in `operations.md`.

## Testing Principles

- Test durable contracts more heavily than implementation details.
- Prefer fixture-based tests over excessive mocking for file/SQLite behavior.
- Every state-changing command should have at least one CLI-level test.
- Tests should run without a real Tango process unless explicitly marked integration.
- Tests must not depend on the caller's real home registry, current project state, or global `~/.loom`.
- Agents and wrappers should be able to rely on stable JSON output and error codes.

## Test Isolation

Every test must use an isolated temp directory.

Recommended environment:

```txt
HOME=<tmp>/home
LOOM_HOME=<tmp>/home/.loom        # optional override if implemented
PWD=<tmp>/workspace
```

If `LOOM_HOME` is supported, tests should prefer it over mutating real `~/.loom`.

Tests should create Loom instances under temp paths such as:

```txt
<tmp>/workspace/repo/docs/specs/feature-x/.loom
```

This ensures CWD-independent resolution is tested naturally.

## Test Categories

### 1. Unit Tests

Scope:

- ID parsing/allocation helpers;
- ref parsing (`N-0001`, `feature-x:N-0001`, `lm_abc:N-0001`);
- slug generation;
- frontmatter parsing/serialization;
- Markdown section append/update helpers;
- event JSON validation;
- delivery rendering templates;
- error envelope formatting.

Requirements:

- no real Tango calls;
- no real global registry;
- no reliance on test execution order.

### 2. Contract Tests

Contract tests verify that generated files and JSON payloads conform to `contracts.md`.

Required contract tests:

- `loom init` writes valid `.loom/loom.json`;
- generated node files have valid frontmatter;
- `loom artifact add` and `loom reference add` update frontmatter in the canonical shape;
- `events.jsonl` contains one valid JSON object per line;
- `--json` output uses the success/error envelope;
- stable error codes are emitted for common failures;
- `loom agent guide` prints the compact guide and is runtime-agnostic.

### 3. CLI Smoke Tests

Each v1 user-facing command should have at least one smoke test. Smoke tests invoke the built CLI or CLI entrypoint with temp filesystem state.

Minimum command coverage:

```txt
loom init
loom create
loom show
loom tree
loom decompose
loom branch
loom link
loom decide
loom resolve
loom index rebuild
loom search
loom context
loom artifact add|list
loom reference add|list
loom registry list|resolve
loom agent guide
loom agent join|default|subscribe
loom inbox send|next|show|accept|done
loom notify
```

`loom spawn` and `loom dispatch` may use mocked Tango in normal tests and real Tango only in optional integration tests.

### 4. Projection/Rebuild Tests

Required scenarios:

- create nodes, delete `.loom/index.sqlite`, run `loom index rebuild`, then verify `show`, `tree`, and `search` work;
- manual edit to node Markdown followed by `loom index rebuild` updates search results;
- invalid frontmatter yields `INVALID_FRONTMATTER` with file path details;
- `loom index rebuild` does not delete `.loom/runtime/runtime.sqlite` or runtime rows;
- closure table supports subtree filtering.

### 5. Runtime DB Tests

Required scenarios:

- `loom inbox send` creates an inbox row in `runtime/runtime.sqlite`;
- inbox state transitions: `open -> accepted -> done`;
- cancelled items are not returned by `inbox next` by default;
- participants and subscriptions survive `loom index rebuild`;
- delivery failure updates delivery bookkeeping without losing the inbox item.

### 6. Operations/Concurrency Tests

Required scenarios:

- mutation lock prevents concurrent writes from corrupting node files;
- lock timeout returns `LOCK_TIMEOUT`;
- atomic write failure does not leave a partially-written final node file;
- node ID allocation does not duplicate IDs under serialized concurrent commands;
- event append remains line-delimited and parseable after multiple mutations.

These may be slower tests but should be deterministic.

### 7. Resolution Tests

Required scenarios:

- explicit `-L` wins over CWD discovery;
- qualified ref `alias:N-0001` resolves using the alias qualifier;
- `LOOM_CONTEXT` resolves when CWD is unrelated;
- alias conflict returns `AMBIGUOUS_LOOM`;
- missing Loom returns `LOOM_NOT_FOUND`;
- missing node returns `NODE_NOT_FOUND`.

### 8. Search/Context Tests

Required scenarios:

- BM25/FTS search finds node body text;
- search can filter with `--under`;
- archived nodes are excluded or clearly marked according to command policy;
- `loom context` includes node body, ancestor summaries, children, links, artifacts/references, and workspace paths;
- `loom context` does not dump referenced file contents by default.

### 9. Delivery/Tango Adapter Tests

Normal tests should use a fake Tango adapter.

Required fake-adapter scenarios:

- successful `tango message` marks delivery as `delivered`;
- failed `tango message` marks delivery as `failed` and preserves inbox item;
- rendered notifications include inbox item ID and fetch command;
- parent/lead to child/worker uses request-style rendering;
- child/worker to parent/lead uses update-style rendering.

Optional integration tests may call real `tango` if available, but must be skipped by default unless explicitly enabled.

Suggested opt-in:

```txt
LOOM_TEST_TANGO_INTEGRATION=1
```

## Golden Fixtures

Maintain a small set of canonical fixtures under the package test fixtures directory, e.g.:

```txt
packages/loom/test/fixtures/
  minimal-loom/
  graph-with-branches/
  graph-with-artifacts/
  graph-with-inbox/
```

Golden fixtures should be human-readable and intentionally small. They should exercise contract compatibility, not snapshot huge command output.

Golden outputs may be used for:

- generated node frontmatter;
- context rendering;
- delivery rendering;
- `loom agent guide` compact output.

Avoid brittle snapshots for timestamps, absolute paths, SQLite binary contents, or ordering that is not contractually stable.

## JSON Output Stability

Commands used by agents or wrappers must have JSON tests.

At minimum:

```txt
loom create --json
loom show --json
loom search --json
loom context --json
loom inbox send --json
loom inbox show --json
loom inbox next --json
loom inbox done --json
```

JSON tests should assert structural fields and stable error codes, not incidental display text.

## Mocking Boundaries

Mock:

- Tango process/message calls in normal tests;
- clocks, when asserting timestamps;
- ID generation only when deterministic fixtures need exact IDs.

Do not mock:

- Markdown parsing/writing;
- SQLite schema creation/migration;
- Loom resolution behavior;
- registry database behavior.

Those are core Loom contracts and should be tested against real temp files/databases.

## Required Test Helpers

Implementation should provide test helpers for:

```ts
createTempWorkspace(): Promise<TestWorkspace>
runLoom(args: string[], opts?: RunOptions): Promise<CliResult>
readNodeFrontmatter(path: string): Promise<unknown>
readEventsJsonl(path: string): Promise<unknown[]>
openIndexDb(loomPath: string): Database
openRuntimeDb(loomPath: string): Database
```

`runLoom` should allow setting env, cwd, and fake Tango adapter behavior.

## CI Contract

Default CI/test command should run:

- unit tests;
- contract tests;
- CLI smoke tests;
- projection/rebuild tests;
- fake delivery tests.

Default CI should not require:

- real Tango;
- tmux;
- Pi;
- network access;
- embeddings or remote services.

Optional integration tests may require real Tango/tmux and should be opt-in.

## Acceptance Before First Implementation Merge

Before declaring the initial v1 implementation usable, tests should prove this vertical slice:

```bash
loom init --name feature-x --title "Feature X"
loom -L feature-x create "Top-level proposal" --kind proposal
loom -L feature-x decompose N-0001 "Storage" "Search" "Agents"
loom -L feature-x branch N-0002 "Markdown" "SQLite" "Hybrid"
loom -L feature-x decide N-0002 --choose N-0005 --summary "Hybrid is the v1 choice"
loom -L feature-x reference add N-0005 --workspace repo packages/tango/src/start.ts --label "Tango start"
loom -L feature-x index rebuild
loom -L feature-x search "Hybrid"
loom -L feature-x context N-0005
loom -L feature-x agent guide
loom -L feature-x agent join worker-a --role worker
loom -L feature-x inbox send worker-a --type review_request --node N-0005 --message "Review this choice"
loom -L feature-x inbox next worker-a
loom -L feature-x inbox done M-0001 --summary "Reviewed"
```

The same flow should pass from a CWD outside the Loom root using `-L feature-x`.
