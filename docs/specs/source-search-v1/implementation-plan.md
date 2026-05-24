# Source Search V1 Implementation Plan

## Purpose

Implement **Source Search** as a Pi package/extension that gives agents one native discovery tool, `ranked_search`, backed by a Tantivy index. It should become the default first-pass search path when a repo/workspace supports it, while `grep` remains the exact/regex confirmation tool.

Primary validation target: `/home/joe/Documents/Quantiiv/Quantiiv-Playbooks` first, then parent workspace `/home/joe/Documents/Quantiiv` with a workspace registry pointing to `Quantiiv-Playbooks`.

Design source: `docs/specs/source-search-v1/design.md`.

## Research summary

### bravo-pi-mono package patterns

Use a new workspace package:

```text
packages/source-search/
```

Recommended package name:

```text
@bravo/source-search
```

Repo conventions found:

- Root `package.json` uses npm workspaces: `packages/*`.
- Package names use `@bravo/*`.
- Pi packages expose extensions through package `pi.extensions`.
- Skills live under package `skills/<skill-name>/SKILL.md` and are exposed by package `pi.skills`.
- Most packages use TypeScript `NodeNext`, `ES2022`, `strict`, `outDir: dist`.
- Tool prompt patterns:
  - `promptSnippet` / `promptGuidelines` on `defineTool`.
  - `before_agent_start` hook appends compact system prompt fragments.
  - `web-evidence-cache`, `async-subagents`, `showcase`, `caveman`, and `bravo-goals` already use this pattern.
- Current package dependency baseline from scout:
  - Node `v22.22.0`
  - npm `10.9.4`
  - TypeScript `6.0.3`
  - Pi packages `@earendil-works/* 0.74.1`

No Rust sidecar exists in this monorepo today. Source Search will introduce that pattern.

### Tantivy/Rust research

Use Tantivy V1 backend now.

Current researched version:

```text
tantivy = 0.26.1
minimum Rust = 1.86
```

Relevant Tantivy APIs:

- Schema builder:
  - `Schema::builder()`
  - `add_text_field`
  - `add_u64_field`
  - `TEXT`, `INDEXED`, `STORED`, `IndexRecordOption`
- Query parser:
  - `QueryParser::for_index`
  - `set_field_boost`
  - `parse_query`
  - `parse_query_lenient`
  - Do **not** use conjunction-by-default for V1 `ranked_search`; default behavior should favor recall/OR-style broad discovery.
- BM25:
  - default BM25 scorer with `K1 = 1.2`, `B = 0.75`
  - `Searcher` provides BM25 stats
- Snippets:
  - `SnippetGenerator::create`
  - `set_max_num_chars`
  - `snippet_from_doc` / `snippet`
- Updates:
  - use `delete_term(path_exact)` + add document + `commit()`
  - no confirmed public `update_document` API needed
- Locking:
  - Tantivy writer lock permits one writer
  - lock failures surface as `LockFailure` / `DirectoryLockBusy`
  - readers should use one consistent searcher per query

### Quantiiv validation target

`/home/joe/Documents/Quantiiv/Quantiiv-Playbooks` is good first validation repo because it is content-heavy, markdown-heavy, and search usefulness is obvious.

Relevant structure:

```text
Quantiiv-Playbooks/
  source/restaurant-analysis/     # canonical source
  graph/                          # contracts/schema
  namespaces/                     # base/TestClient overlays
  quantiiv/playbooks/             # package code
  scripts/                        # validation/publish tooling
  tests/                          # repo tests
  .claude/skills/                 # repo-local skills
  generated/                      # machine-owned output; likely exclude initially
```

Repo guidance from `CLAUDE.md` says:

- canonical source is `source/restaurant-analysis/`
- `generated/` is machine-owned output
- validate with `./scripts/validate.sh development`

Suggested Source Search config for initial validation should index useful source/control surfaces and exclude generated/staged artifacts.

## Architecture

### Package layout

```text
packages/source-search/
  package.json
  tsconfig.json
  README.md
  bin/
    source-search                # optional shim; bin may point to dist instead
  src/
    cli.ts                       # JS CLI wrapper over sidecar, if needed
    config.ts                    # config discovery/merge/validation
    workspace.ts                 # git/workspace scope resolution
    discovery.ts                 # startup discovery for prompt injection
    sidecar.ts                   # child_process invocation/protocol mapping
    types.ts                     # request/response/error types
    render.ts                    # Pi renderer helpers
    promptModule.ts              # compact prompt generation
  extensions/
    pi/
      index.ts                   # registers ranked_search + before_agent_start
  skills/
    source-search/
      SKILL.md
  sidecar/
    Cargo.toml
    src/
      main.rs
      config.rs
      corpus.rs
      index.rs
      query.rs
      manifest.rs
      protocol.rs
      security.rs
      workspace.rs
  test/
    *.test.ts
```

Package metadata:

```json
{
  "name": "@bravo/source-search",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Pi extension for Tantivy-backed ranked lexical source search.",
  "scripts": {
    "check": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.json && cargo build --manifest-path sidecar/Cargo.toml",
    "build:sidecar:release": "cargo build --manifest-path sidecar/Cargo.toml --release",
    "test": "npm run build && node --test dist/test/*.test.js"
  },
  "bin": {
    "source-search": "./dist/src/cli.js"
  },
  "devDependencies": {
    "@types/node": "latest",
    "typescript": "latest"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "engines": {
    "node": ">=22.13"
  },
  "pi": {
    "extensions": ["./extensions/pi"],
    "skills": ["./skills"]
  }
}
```

Implementation note: V1 must include a deterministic packaged sidecar path before Source Search is rolled out as a normal Pi/async-subagents extension. Local development may use `cargo build`, but runtime lookup must prefer a packaged binary and use PATH only as an explicit development fallback.

### Rust sidecar

Executable strategy:

- Public npm CLI: `source-search`, implemented by `dist/src/cli.js` with a shebang.
- Rust executable: `source-search-sidecar`.
- TS CLI discovers and invokes `source-search-sidecar`.
- Development lookup order:
  1. `SOURCE_SEARCH_SIDECAR` env override.
  2. `packages/source-search/sidecar/target/debug/source-search-sidecar`.
  3. `packages/source-search/sidecar/target/release/source-search-sidecar`.
- Packaged lookup order:
  1. `packages/source-search/vendor/<platform-arch>/source-search-sidecar` included in npm package.
  2. PATH fallback only when `SOURCE_SEARCH_DEV=1`.

Runtime failure when no compatible binary exists: explicit `SidecarUnavailableError` with package rebuild/install guidance, not generic `IndexUnavailableError`.

Required CLI subcommands:

```bash
source-search query --repo /path --query "..." --limit 20 --json
source-search index --repo /path --force --json
source-search status --repo /path --json
source-search config validate --repo /path --json
source-search purge --repo /path --json
```

Protocol requirements:

- JSON stdout only under `--json`.
- Every response includes `protocolVersion`.
- Wrapper rejects incompatible protocol versions.
- Exit codes:
  - `0` success
  - `1` actionable/user error represented in JSON
  - `2` config/query validation error
  - `3` index unavailable/corrupt after recovery
  - `4` protocol/version mismatch
  - `>=10` unexpected failure

### Native Pi extension

Register only one native tool in V1:

```text
ranked_search
```

Tool parameters:

```ts
{
  query: string,
  path?: string,
  limit?: number
}
```

Tool behavior:

- Resolve current scope from cwd/path/workspace config.
- Call sidecar query.
- Sidecar auto-builds/refreshes within budgets.
- Return compact ranked snippets.
- Render concise results with paths, scores, fields, snippets, freshness, warnings.

`before_agent_start` behavior:

- Run metadata-only Source Search discovery.
- Do not build/refresh index at startup.
- Append compact `## Source Search` prompt section.
- If configured scope exists, tell agent to prefer `ranked_search` as default first-pass discovery.
- If only candidate child repos are detected, tell agent they are not active scope and suggest skill/config.

### Skill

Create:

```text
packages/source-search/skills/source-search/SKILL.md
```

Skill should cover:

- Use `ranked_search` first for broad lexical discovery when startup prompt says Source Search available.
- Use `grep` for exact/regex confirmation.
- Use `read` for known files.
- Source Search is lexical BM25, not semantic search; try synonyms.
- How to create/edit `.pi/source-search.json` and `.pi-local/source-search.json`.
- How to configure parent workspaces.
- How to configure dev/prod/worktree variants as separate checkout paths.
- Do not parse `AGENTS.md` as config; use explicit workspace registry.
- Do not allowlist ignored paths without user approval.
- How to recover from `CheckoutChangedError`, `NoWorkspaceRegistry`, `ConfigError`, `IndexUnavailableError`.

## Config design

Config parsing/merging must have one canonical implementation. V1 should make the Rust sidecar authoritative for config validation, merge semantics, and corpus decisions. The TypeScript wrapper may perform lightweight startup discovery, but when it needs exact config interpretation it should call `source-search config resolve --json` or share a generated JSON schema/golden fixtures with Rust.

Add a `config resolve` CLI command if needed:

```bash
source-search config resolve --root /path --json
```

Golden fixtures must cover unknown keys, local overrides, array concatenation, workspace replacement, invalid globs, absolute paths, and `enabled:false`.

### Repo config

Paths:

```text
.pi/source-search.json
.pi-local/source-search.json
```

Initial Quantiiv-Playbooks repo config candidate:

```json
{
  "enabled": true,
  "allowlist": [],
  "exclude": [
    "generated/**",
    ".rendered/**",
    "dist/**",
    "build/**",
    ".pytest_cache/**",
    "*.egg-info/**"
  ],
  "maxFileBytes": 1048576,
  "maxFiles": 50000,
  "maxIndexBytes": 536870912,
  "refreshBudgetMs": 3000,
  "initialIndexBudgetMs": 15000,
  "fields": {
    "filename": 6,
    "path": 4,
    "symbols": 5,
    "headings": 4,
    "content": 1
  }
}
```

Note: do not commit or write this to Quantiiv-Playbooks until implementation is ready and user approves. Initial testing can use `.pi-local/source-search.json`.

### Parent workspace config

Target parent:

```text
/home/joe/Documents/Quantiiv
```

This parent is not itself a git repository. Source Search must support non-git workspace roots by looking for `.pi/source-search.json` and `.pi-local/source-search.json` in cwd. It must not recursively index or search arbitrary sibling repos unless they are configured in `workspace.repos`. Bounded immediate child checkout detection is prompt/setup guidance only, not active scope.

Initial parent config should point only to Quantiiv-Playbooks for first validation:

```json
{
  "enabled": true,
  "workspace": {
    "repos": [
      { "name": "playbooks", "path": "Quantiiv-Playbooks" }
    ],
    "defaultRepos": ["playbooks"]
  }
}
```

Later expansion can add the core ROGER repos:

```json
{
  "workspace": {
    "repos": [
      { "name": "lib", "path": "Quantiiv-Lib" },
      { "name": "switchyard", "path": "Switchyard" },
      { "name": "skills", "path": "Quantiiv-Agent-Skills" },
      { "name": "playbooks", "path": "Quantiiv-Playbooks" },
      { "name": "gateway", "path": "Quantiiv-Agent-Gateway" },
      { "name": "roger", "path": "ROGER" },
      { "name": "tooling", "path": "Optimized-Development-Tooling" }
    ],
    "defaultRepos": ["lib", "switchyard", "skills", "playbooks", "gateway", "roger"]
  }
}
```

## Async subagents integration

Current async-subagents behavior launches child Pi with:

```text
--no-extensions
-e <child-control-extension>
```

Child agents only get extensions declared on the agent definition or selected variant. This is visible in launch logs and in `packages/async-subagents/src/piHarness.ts` / `agentDefinitions.ts`.

There does not appear to be a package-level “global default extensions for all children” capability today. Agent definitions support frontmatter:

```yaml
extensions:
  - /path/to/extension
```

But adding Source Search to every user agent definition manually is brittle.

### Required async-subagents enhancement

Add this as a separate implementation slice with its own tests before enabling Source Search by default for child agents. Source Search can first work through explicit agent-definition `extensions`; default child extension support is a platform feature and must not silently weaken child isolation.

Candidate config file:

```text
~/.async-subagents/config.json
```

Schema V1:

```json
{
  "version": 1,
  "defaultExtensions": [
    {
      "path": "/absolute/path/to/loadable/extension/index.ts",
      "approved": true,
      "label": "source-search"
    }
  ]
}
```

Security/resolution behavior:

- Reject unknown config keys.
- Require absolute paths.
- Canonicalize realpaths and dedupe by realpath.
- Validate each path is a loadable extension file; reject bare directories unless Pi `-e` supports them in child launches.
- Reject symlink substitution where configured path and realpath cross trust boundaries unexpectedly.
- Require `approved: true`; unapproved entries are ignored with a warning.
- Reject project-local/mutable paths unless they are explicitly in user-owned config with `approved: true` and the resolved path is logged prominently.
- Preserve project-agent-definition path capability approval rules.
- Merge default extensions before definition/variant extensions; definition/variant extensions can still add more.
- Record defaults, provenance, and resolved paths in launch logs/status.
- Agent catalog capability summary should include `extensions` when defaults add Source Search.

Alternative if a JSON config already exists elsewhere: extend that instead of adding a new file. If no config exists, add minimal config support.

Validation:

- Existing child launch still includes `--no-extensions`.
- Child launch adds `-e <source-search extension>` from approved default config plus `-e child-control` runtime extension.
- Child prompt receives `## Source Search` startup discovery when cwd supports it.
- Child can call `ranked_search` without each agent definition listing it.
- Tests cover malicious symlink/path substitution, unknown keys, nonexistent paths, directory paths, duplicate paths, and unapproved defaults.

## Implementation phases

### Phase 0 — finalize design/plan

- Review `docs/specs/source-search-v1/design.md`.
- Review this implementation plan.
- Reviewer pass and update plan.

Acceptance:

- Plan names concrete package layout, sidecar strategy, config paths, validation repos, and async-subagents integration.

### Phase 1 — package skeleton

Create `packages/source-search` with:

- `package.json`
- `tsconfig.json`
- `README.md`
- `extensions/pi/index.ts`
- `src/promptModule.ts`
- `skills/source-search/SKILL.md`
- placeholder `ranked_search` tool returning `IndexUnavailableError` / not implemented
- tests verifying tool metadata and prompt injection

Commands:

```bash
npm run check --workspace @bravo/source-search
npm test --workspace @bravo/source-search
```

Acceptance:

- Package builds.
- Pi can load extension.
- Startup prompt injection works.
- Tool has `promptSnippet` and `promptGuidelines`.

### Phase 2 — sidecar foundation

Add Rust sidecar under `packages/source-search/sidecar`.

Implement:

- JSON protocol types
- minimal Tantivy compile smoke using `tantivy = 0.26.1` for schema/query/snippet imports
- `config validate`
- optional `config resolve`
- `status` with repo identity and cache path
- cache directory creation with `0700`; files `0600` where applicable
- manifest read/write with atomic rename
- repo/worktree identity detection
- sidecar binary discovery from TS wrapper
- protocol version, malformed JSON, stderr/stdout, and exit-code mapping

Acceptance:

```bash
cargo test --manifest-path packages/source-search/sidecar/Cargo.toml
npm run build --workspace @bravo/source-search
node packages/source-search/dist/src/cli.js config validate --repo /home/joe/Documents/Quantiiv/Quantiiv-Playbooks --json
node packages/source-search/dist/src/cli.js status --repo /home/joe/Documents/Quantiiv/Quantiiv-Playbooks --json
```

If package bin is linked in the workspace, equivalent command:

```bash
npm exec --workspace @bravo/source-search -- source-search status --repo /home/joe/Documents/Quantiiv/Quantiiv-Playbooks --json
```

### Phase 3 — corpus enumeration and security filters

Implement:

- `git ls-files -z -co --exclude-standard`
- config allowlist/exclude globs
- binary detection
- max file size
- default secret denylist, including inside allowlisted paths
- hard `.git/` exclusion
- ignored-path allowlist warning
- symlink escape rejection
- submodule/nested repo boundaries
- sparse checkout present-files-only behavior
- removed-file detection for later index deletion
- config-hash tracking so corpus-removing config changes trigger safe deletion/rebuild
- moved/missing repo cache status for purge cleanup
- error redaction: no cache paths/content in normal tool errors unless diagnostic mode

Acceptance:

- Unit tests for newline paths, ignored files, allowlisted ignored files, allowlist warnings, symlink escape, denylisted files, `.git` exclusion, permissions, removed-file deletion planning, and config-removal rebuild/purge behavior.
- `status` reports candidate/indexable/skipped counts.

### Phase 4 — Tantivy indexing/query

Implement:

- Tantivy schema with exact `path_exact` / `doc_id`.
- Field weights.
- Lightweight symbol/heading extraction.
- Initial index build.
- Incremental delete+add refresh.
- Query parser with recall-oriented OR/default broad matching.
- BM25 results and snippets.
- Multi-term query test where top results may match useful subsets, not every term.
- Budget handling and stale/partial warnings.
- Branch/checkout safety: compare manifest `HEAD`, branch, worktree root, git dir, and common-dir before query.
- `CheckoutChangedError` when `HEAD` changed and refresh cannot complete safely.
- Stale-path filtering if any degraded stale mode is implemented.

Acceptance:

```bash
node packages/source-search/dist/src/cli.js index --repo /home/joe/Documents/Quantiiv/Quantiiv-Playbooks --force --json
node packages/source-search/dist/src/cli.js query --repo /home/joe/Documents/Quantiiv/Quantiiv-Playbooks --query "restaurant analysis revenue traffic location" --limit 10 --json
```

Expected result paths should include at least one top-N hit under relevant Playbooks subtrees such as:

```text
source/restaurant-analysis/revenue/
source/restaurant-analysis/traffic/
source/restaurant-analysis/location/
```

Do not make manual BM25 rank order a brittle test; use curated fixture repos for deterministic ranking assertions.

### Phase 5 — Pi tool integration

Wire `ranked_search` to sidecar.

Implement:

- parameters `query`, `path`, `limit`
- cancellation/timeout mapping
- compact renderer
- tool errors as teaching surface
- startup discovery prompt variants:
  - single repo supported
  - workspace supported
  - no registry but child candidates detected
- fake-sidecar TS tests for protocol mismatch, malformed JSON, stdout/stderr separation, exit-code mapping, timeout kill, cancellation propagation, and stderr truncation

Acceptance:

- Pi session in `Quantiiv-Playbooks` receives Source Search prompt.
- `ranked_search` works in repo cwd.
- Broad query returns ranked snippets.
- Exact follow-up with `grep/read` remains natural.

### Phase 6 — workspace fan-out and parent registry validation

Implement workspace query behavior before validating parent workspace config.

Workspace query behavior:

- TS wrapper resolves workspace defaults.
- Invoke sidecar once per configured checkout.
- Use per-repo limits high enough to merge global top-K, e.g. `limit * 2` capped.
- Prefix or annotate every result with repo name and workspace-relative path.
- Aggregate freshness/warnings per repo.
- If one repo fails, return partial results with clear warning unless all repos fail.
- `path` can select one repo/subpath; if path crosses multiple repos, return a scope error with suggestions.
- Ranking across repos is approximate; normalize only if needed after empirical testing. Do not hide repo source.

Set up parent workspace config for Quantiiv with Playbooks only.

Target file candidate:

```text
/home/joe/Documents/Quantiiv/.pi-local/source-search.json
```

Content:

```json
{
  "enabled": true,
  "workspace": {
    "repos": [
      { "name": "playbooks", "path": "Quantiiv-Playbooks" }
    ],
    "defaultRepos": ["playbooks"]
  }
}
```

Acceptance:

- Pi session from `/home/joe/Documents/Quantiiv` receives Source Search prompt saying configured child checkout `playbooks` is searchable.
- `ranked_search` from parent returns results prefixed or clearly scoped to `playbooks`.
- `path: "Quantiiv-Playbooks/source/restaurant-analysis"` restricts search correctly.

### Phase 7 — async-subagents default extension support

Implement default child extensions in `packages/async-subagents` if no existing mechanism is found. Treat this as a platform/security slice, not a Source Search-only convenience.

Implementation candidates:

- add config loader in `packages/async-subagents/src/config.ts`
- merge defaults in launch/prompt assembly before `piHarness` args
- update catalog capability derivation
- tests for launch command args and security behavior

Acceptance:

- `~/.async-subagents/config.json` can list an approved Source Search extension entry.
- Child launch includes Source Search without editing each agent definition.
- Child launched with cwd `/home/joe/Documents/Quantiiv/Quantiiv-Playbooks` receives Source Search prompt and can call `ranked_search`.
- Tests cover symlink substitution, unknown keys, nonexistent paths, duplicate paths, unapproved entries, and project-local path provenance logging.

### Phase 8 — sidecar packaging for normal use

Before enabling Source Search as a default async-subagents extension, add packaged sidecar support:

- Define supported target triples for first release, at minimum current Linux x64 dev target.
- Release build writes/copies binary to `packages/source-search/vendor/<platform-arch>/source-search-sidecar`.
- Package `files` includes `dist`, `extensions`, `skills`, and `vendor` binaries.
- Runtime binary selection checks platform/arch and protocol version.
- PATH fallback only when `SOURCE_SEARCH_DEV=1`.
- Tests cover missing binary, wrong platform, protocol mismatch, and dev fallback.

Acceptance:

```bash
npm run build:sidecar:release --workspace @bravo/source-search
npm run build --workspace @bravo/source-search
npm test --workspace @bravo/source-search
```

### Phase 9 — broader validation

After Playbooks passes:

Validate on current repo:

```text
/home/joe/Documents/projects/bravo-pi-mono
```

Queries:

- `before_agent_start promptSnippet promptGuidelines`
- `async subagents extensions child-control launch no-extensions`
- `web evidence cache BM25 lookup`

Validate on Quantiiv parent workspace with more repos added:

```text
/home/joe/Documents/Quantiiv
```

Suggested next repos:

- `Quantiiv-Lib`
- `Switchyard`
- `Quantiiv-Agent-Skills`
- `ROGER`
- `Quantiiv-Agent-Gateway`

Do not auto-add ignored/generated/secret-bearing paths.

## Test matrix

### Unit tests

Source Search TS:

- config merge golden fixture parity with Rust `config resolve`
- prompt injection text
- startup discovery categories
- sidecar error mapping
- renderer truncation
- fake-sidecar protocol tests: version mismatch, malformed JSON, stderr/stdout separation, exit-code mapping, timeout/cancellation

Source Search Rust:

- config parsing/merge fixtures
- repo identity/worktree detection
- corpus enumeration with weird paths
- denylist/symlink filters including allowlisted ignored files
- cache/file permissions
- `.git` hard exclusion
- removed-doc deletion and config-removal rebuild/purge planning
- manifest atomic write/read
- Tantivy update delete+add
- query parser errors
- recall-oriented multi-term query behavior

Async-subagents:

- default extension config loading
- merge/dedupe with agent/variant extensions
- launch args include default extension and child-control
- project-local untrusted extension rules still hold

### Integration tests

Use temp git repos:

- single repo with markdown/code files
- ignored file excluded
- allowlisted ignored file included only when configured, while secret denylist still applies
- branch switch produces `CheckoutChangedError` or safe refresh, with deleted/renamed file checks
- worktree roots have separate cache identities
- parent workspace with two child repos and partial one-repo failure
- symlink escape rejected

### Manual validation queries for Quantiiv-Playbooks

From repo cwd:

```text
restaurant analysis revenue traffic location
publish artifact namespace manifest
graph compiler skill refs contracts
customer survey menu pricing
```

From parent cwd:

```text
playbook graph validation
restaurant analysis channel revenue
publish manifest namespace
```

Expected behavior:

- returns `source/restaurant-analysis/**`, `graph/**`, `scripts/**`, `tests/**` where appropriate
- excludes `generated/**` / `.rendered/**` by initial config
- snippets are compact and useful
- agent naturally follows with `read`

## Open decisions

1. Should local validation configs be written under `.pi-local/` or temporary external config path first?
   - Recommendation: `.pi-local/source-search.json` after user approval.
2. Should `ranked_search` support explicit `repos?: string[]` in V1?
   - Recommendation: no; use `path` and workspace defaults first.
3. Should generated Playbooks output be excluded or indexed for comparison workflows?
   - Recommendation: exclude initially; allowlist later only when user asks.
4. Should async-subagents default extensions live in `~/.async-subagents/config.json` or another existing config location?
   - Recommendation: add minimal `~/.async-subagents/config.json` unless existing config is found during implementation.

## Risks

- Rust sidecar introduces new build/release complexity in a TS-first monorepo.
- Tantivy 0.26.1 requires Rust 1.86; developer hosts must meet this.
- Startup discovery must stay fast and metadata-only.
- Cached indexes contain sensitive text; cache permissions/purge behavior are mandatory.
- Branch switches can produce dangerously stale search unless fail-closed behavior is implemented.
- Async subagent default extension support changes child launch behavior; must preserve isolation and explicit security rules.
