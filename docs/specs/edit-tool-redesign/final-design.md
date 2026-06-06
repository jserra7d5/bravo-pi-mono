# Edit tool — final synthesized design (v1)

**Status:** synthesized from author v0 (`design.md`) + two independent GPT-5.5/high-reasoning reviews
(`review-1-minimalist.out`, `review-2-systems.out`), each grounded in `behavior-shaping`,
`prompt-design`, `context-engineering` (+ `tool-design` for review 2).
**Supersedes** `design.md` §3–4 wherever they differ. The data (`design.md` §1) stands, with two
corrections logged below.
**Date:** 2026-06-05
**Build-ready update (2026-06-05):** the contract + matcher are now implemented as a validated Python
reference and unit suite (**§7**); the build target is a **bravo-pi-mono pi extension that overrides
the built-in `edit` tool** (**§8**). Build this out from §3 (contract), §7 (validated behavior), §8
(architecture + steps).

---

## 1. What the two reviews settled

**Convergence (ship with confidence):**
1. **Harness-first attribution holds.** Both failure modes are weak tool signals + weak locator
   affordances, not model carelessness. (behavior-shaping / `diagnostic-forensics.md`.)
2. **"Smallest possible" must die.** The principle is *oldText is a current, unique locator*. Both
   reviewers, independently, on principles-vs-behaviors grounds.
3. **Lean the always-on surface; demote the rest to the runtime/error/tool tier.** Staleness prose,
   the anti-pattern catalog, and the second example are *behaviors* and per-call token cost — move
   them where they're paid only when relevant. (context-engineering static/runtime tiering;
   behavior-shaping over-prescription / prompt-rot.)
4. **The fuzzy whole-file normalization is a correctness BUG, not a disclosure gap.** My v0 §4.6
   ("surface it in the result") under-reacted. Review 2 grades it **P1 / release-blocking** for the
   redesign. Both insist on a matcher fix, not a note.
5. **Errors must be reliable recovery signals.** behavior-shaping: reflection only helps with a
   reliable signal; today's `not_found` ("check whitespace") is misleading.

**Productive divergence (resolved by layering, not by picking a winner):**
- **Review 1 (minimalist)** — keep the always-on contract tiny; gate *every* addition (even examples)
  on a real eval; don't advertise fuzziness (it invites sloppy copying).
- **Review 2 (systems)** — go further *at the tool layer*: revision-aware read/edit, structured error
  envelopes returning `near_misses`/`occurrences`, scoped fuzzy with raw-span mapping, optional
  `anchor`/`range` locator modes.

These don't conflict: both want a **lean prompt**; they differ on **tool-layer richness**. Resolution
= R1's leanness for the always-on surface + R2's structured recovery for the runtime/tool tier, with
R1's eval-gate discipline staging R2's larger affordances.

**Two corrections to the author's v0 claims (both reviewers):**
- **"60% mutated since read" is a proxy, not proof** (R1). "File edited earlier in the turn" correlates
  with stale-snapshot edits; it does not prove the failing `oldText` came from a stale read. Treat as a
  strong hypothesis pending trace-level confirmation.
- **"The eval set already exists" was overstated** (R1). The 5,843-call corpus is a *corpus*, not an
  *eval*. Replaying recorded calls tests the **matcher/error** changes; it does **not** test whether the
  new **advertisement** shifts the model's generated `oldText`. Those are two separate validation tracks
  (§5).

---

## 2. Decision log (contested points)

| # | Question | Decision | Rationale / which review |
|---|---|---|---|
| D1 | "smallest possible" vs "smallest unique" | **Smallest *unique* span** = the one principle | Both; principles-vs-behaviors |
| D2 | Staleness as always-on guideline? | **No.** One clause ("read the target region if your view may be stale") + structured `stale_snapshot`/`not_found` recovery at the error tier | R1 (behavior, overfires) + R2 (tool can infer it) |
| D3 | Example B (staleness) always-on? | **Cut.** Redundant once `not_found` returns a `read_range`; also cross-tool double-documentation | R1 |
| D4 | Example A (anchor) always-on? | **Keep one compact example, eval-gated for retention** | R1 (only possibly load-bearing) + R2 (justified by 45% frequency) |
| D5 | Anti-pattern catalog always-on? | **Cut from advertisement;** content lives in error messages + this doc | R1 |
| D6 | Advertise fuzzy tolerance in schema? | **No.** Contract says "exact current content." Fuzzy is an implementation tolerance, observable via a structured `match_kind:"fuzzy"` field, not prose | R1 |
| D7 | Fuzzy whole-file normalization | **Fix the matcher (P1).** Scope normalization to the matched raw span; raw→final diff | Both; R2 P1 |
| D8 | Error shape: prose vs structured | **Structured recovery envelope** (JSON in the result text). Errors are runtime-tier, so R1's token concern doesn't apply; structure is the reliable signal R1 also wants | R2 design, R1 compatible |
| D9 | Revision-aware read/edit | **Adopt, Phase 2.** Durable, self-correcting; removes the need for staleness prose | R2 |
| D10 | `anchor`/`range` locator variants | **Optional, Phase 3, eval-gated.** Only if text-locator + structured `not_unique` candidates don't close the mode. Never bare line-range or bare occurrence index (unstable without `revision`/`expected_text`) | R2 proposes, R1 caution applied |

---

## 3. The final contract (tiered)

### 3.1 Always-on surface (paid every advertisement — keep minimal)

**description**
```text
Edit one file by replacing text. Each edits[].oldText must identify exactly one region of the file's
current content; multiple edits are matched against the original file, so their targets must be
disjoint. For new files or whole-file rewrites, use write instead.
```

**promptSnippet**
```text
Replace unique current text regions in one file; batch disjoint edits in one call.
```

**promptGuidelines** (3; principle-led; no restatements)
```text
1. Copy oldText from the file's current content. If your view of the file may be stale, read the
   target region first.
2. Make oldText the smallest span that is UNIQUE — not the smallest substring. If the text repeats,
   add a nearby anchor (an enclosing declaration, heading, or distinctive line) until it matches once.
3. Batch separate changes as multiple edits[] in one call; each matches the original file, so keep
   them disjoint and merge nearby/overlapping changes into a single edit.
```

**schema descriptions** (single source of truth for constraints)
```text
path:    Path to the file to edit (relative to cwd, or absolute).
edits:   One or more replacements in a single file. Each oldText is matched against the original file
         content — not the result of earlier edits in this call — so targets must be disjoint.
oldText: Text to replace. Must match exactly one region of the file's current content. Include enough
         surrounding context to disambiguate repeated text; avoid large unrelated blocks.
newText: Replacement text.
```

**One example** (compact; retain only if §5 Track B shows it shifts `not_unique`)
```text
# Disambiguate a repeated locator: `timeout: 30` appears 3×, so the bare span is not unique —
# anchor on the enclosing key so it matches exactly once.
edit("config.ts", [{ oldText: "retry:\n    timeout: 30", newText: "retry:\n    timeout: 60" }])
```

### 3.2 Runtime / error tier (paid only on failure — structured, reliable recovery)

Emit a compact JSON envelope in the result text. Minimum fields: `code`, `path`, `edit_index`,
`message`, `suggested_action`, plus a `recovery` block carrying the *reliable signal* for that code.

```jsonc
// not_found
{ "code":"not_found", "path":"x.ts", "edit_index":0,
  "message":"oldText did not match the file's current content.",
  "suggested_action":"read_range_and_retry",
  "recovery":{
    "staleness":{ "file_mutated_since_last_read": true, "last_read_revision":"abc", "current_revision":"def" },
    "read_range":{ "path":"x.ts", "offset":120, "limit":30 },
    "near_misses":[ { "line_start":124, "line_end":131, "score":0.82, "preview":"…" } ] } }

// not_unique  — return the candidate occurrences so the model can pick + anchor
{ "code":"not_unique", "path":"x.ts", "edit_index":0, "occurrence_count":3,
  "message":"oldText matches 3 regions; it must identify exactly one.",
  "suggested_action":"retry_with_adjacent_anchor_from_target_occurrence",
  "occurrences":[ { "occurrence":1, "line_start":42, "before":"function a()", "match":"timeout: 30", "after":"}" },
                  { "occurrence":2, "line_start":88, "before":"retry:",       "match":"timeout: 30", "after":"}" } ] }

// overlap / no_change — one line + suggested_action (merge_or_disjoint / it's a no-op after normalization)
```

`stale_snapshot` is a distinct `code` once revisions exist (Phase 2); until then its signal rides
inside `not_found.recovery.staleness` when the tool can infer it.

### 3.3 Tool-layer affordances (the durable fixes)

**Matcher correctness (Phase 1 — P1, ship-blocking).** Replace the whole-file-normalization path:
```
1. Try exact match.
2. If fuzzy is needed, normalize ONLY for locating.
3. Maintain a normalized-index → raw-index map.
4. Map the matched fuzzy span back to the raw file span.
5. Apply the replacement to that raw span only.
6. Generate diff/patch from RAW original → final written content (so any normalization is visible).
7. If the raw-span mapping is ambiguous, fail with a structured `fuzzy_ambiguous` + candidates.
```

**Structured guidance fields** on the tool definition (context-engineering / `guidance-fields.md`):
- `invariants`: edits match the original snapshot; replacement spans are disjoint; **fuzzy never
  mutates outside the matched raw span**; diff is raw-original→final.
- `fallback`: `not_found→read_range_and_retry`, `not_unique→retry_with_anchor`, `overlap→merge_or_disjoint`.
- `use_when` / `avoid_when`: use `edit` for targeted replacements; use `write` for new files / full
  rewrites; `read` before uncertain or possibly-stale edits.

**Structured success result** (lets the model verify without a re-read):
```jsonc
{ "status":"ok", "path":"x.ts", "edits_applied":2, "first_changed_line":88,
  "matches":[ { "edit_index":0, "match_kind":"exact", "line_start":88, "line_end":91 },
              { "edit_index":1, "match_kind":"fuzzy", "line_start":140, "line_end":144 } ],
  "diff":"…", "patch":"…" }
```

**Revision-aware read/edit (Phase 2).** `read` returns a `revision`; `edit` accepts/infers
`base_revision`; if the file changed since the model's last read, return `code:"stale_snapshot"` with a
`read_range` instead of a confusing `not_found`. This is what makes staleness self-correcting and lets
the always-on clause (guideline 1) stay a single sentence.

**Locator variants (Phase 3 — optional, eval-gated).** Keep `{oldText}` as the default mode. Add only
if Track-B eval shows the text locator + structured `not_unique` candidates don't close the mode:
- `anchor`: `{ anchor_text, oldText, occurrence_within_anchor? }`
- `range`: `{ start_line, end_line, expected_text | expected_hash }`
Guard rails: **never** a bare line range or bare `occurrence:N` — both silently edit the wrong region
after drift unless bound to `revision`/`expected_text`.

---

## 4. Phasing & severity

| Phase | Change | Severity | Why first |
|---|---|---|---|
| **1** | Matcher: scoped fuzzy + raw→final diff + `fuzzy_ambiguous` | **P1 correctness** | Silent whole-file mutation is a data-integrity bug; invisible in the diff today |
| **1** | Structured `not_found` / `not_unique` envelopes (near_misses, occurrences) | **P1 reliability** | The reliable recovery signal; biggest behavioral ROI, no per-call cost |
| **1** | Lean always-on contract (3.1) | **P2** | Removes the misweighted "smallest" rule that drives `not_unique` |
| **2** | Revision-aware read/edit + `stale_snapshot` + structured success result + guidance fields | **P2** | Durable staleness fix; lets the prompt stay one sentence |
| **3** | `anchor`/`range` locator modes | **P3, eval-gated** | Only if the mode isn't already closed; risk of new footguns |

---

## 5. Validation — two distinct tracks (corrects v0 §6)

**Track A — deterministic matcher/error replay (uses the 5,843-call corpus).** Re-run the recorded
`(file, oldText…)` through the **new matcher**: assert scoped normalization never mutates outside the
matched span; diffs are raw→final; `not_found`/`not_unique` now produce *resolvable* structured
recovery (a `read_range`/`near_miss` exists; `occurrences` enumerate). Validates the **tool**, not the
contract. `edit-failure-analysis.py` is the starting harness.

**Track B — contract eval (model-in-the-loop; NOT replay).** Sample representative *consumed contexts*
and ask current models to produce edits under the **old vs new advertisement**. Guard metrics:
- overall edit success ↑;
- `not_unique` ↓ **without** `not_found` ↑;
- currently-successful edits don't regress;
- read-call churn doesn't spike;
- multi-edit overlap/no-op doesn't increase.

Case mix (target / adjacent / distant, per `behavior-shaping/eval-driven-iteration.md`): repeated
locators, stale same-file follow-ups, currently-successful small edits, multi-edit disjoint edits,
nearby/overlapping edits, files with intentional Unicode punctuation. **Multi-run** — a single replay
is verification-by-hunch. The one always-on example (3.1) and any retained guideline nuance are kept
only if Track B shows they move the distribution.

---

## 6. One-paragraph synthesis

The durable fix is **a lean always-on contract + a structured, reliable recovery tier + correct tool
affordances** — not more prompt prose. Reduce the model-facing surface to a single principle (oldText
is a *current, unique* locator) and three non-redundant guidelines; stop advertising minimality and
stop advertising fuzziness. Move every recovery cue to the failure path, where it's a structured signal
the model can act on (`near_misses`, `occurrences`, `read_range`, `stale_snapshot`) rather than a
paragraph it can ignore. Fix the matcher so a fuzzy match can never silently rewrite a file and so the
diff always reflects the real on-disk change. Make staleness self-correcting with revisions instead of
asking the model to remember. Then prove it with two separate validations — a deterministic replay for
the tool, and a model-in-the-loop eval for the contract — because the corpus can only validate the
former.

---

## 7. Validation — built and verified (Track A is done)

A deterministic, **zero-token** replay harness + two reference matchers were built (pi/gpt-5.5) and
independently re-run/spot-checked. Artifacts: `harness/`, `fixtures/`; full writeup in
`harness/ASSESSMENT.md`.

- **Reference matchers (Python).** `matcher_old.py` is a faithful port of upstream `edit-diff.ts`
  (reproduces the recorded error on **88%** of the high-fidelity failure subset → the port is trusted).
  `matcher_new.py` is this design — scoped fuzzy + raw→final diff + structured envelopes.
- **Correctness bug confirmed; scoped fix validated.** `blast_radius_demo.py` shows the current matcher's
  fuzzy path silently rewrites unrelated lines (smart quotes→ASCII, trailing-ws stripped) **outside** the
  edit span; the redesigned matcher changes only the matched raw span (**0 outside-span**). A defect in
  the first cut of `matcher_new` — per-character normalization deleted interior/leading spaces, breaking
  fuzzy matching — was found by independent testing and **fixed** (line-level trailing-strip + per-char
  NFKC/fold without per-char trailing-strip). See ASSESSMENT finding #2.
- **Unit suite.** `harness/test_matchers.py` — 12 crafted cases (exact parity, multi-edit/overlap,
  structured `not_found`/`not_unique`, no-op/empty, fuzzy/Unicode/NBSP/CRLF/BOM, the **scoped-fuzzy
  invariant**, leading/interior whitespace). **12/12 pass**, and **mutation-proven** to have teeth:
  re-introducing the bug reds exactly the three fuzzy tests and leaves the exact-path tests green.
- **Honest limits.** The corpus **cannot** measure the bug's real-world *frequency* — windowed
  reconstructions never reproduce a fuzzy-path success (0 of 1,739 sampled successes). Frequency lives in
  the crafted unit cases, not the replay. Fidelity: 260/296 failures carry content, ~90% from windowed
  (partial) reads; `not_unique` occurrences and `not_found` near-miss are *capabilities* proven on
  whatever content is present, not full-file rates.

Net: the contract (§3) and matcher are validated against everything the corpus can show. **The TypeScript
port carries `test_matchers.py` over as its acceptance contract.** (Track B, the model-in-the-loop
contract eval of §5, remains future work.)

---

## 8. Build architecture — a bravo-pi-mono extension that overrides the built-in `edit`

The redesign ships as a **pi extension in bravo-pi-mono**, not a patch to upstream pi-mono. It registers
a tool named `edit`, which overrides the built-in.

### 8.1 Mechanism (verified against the codebase)

- pi extensions register tools via `pi.registerTool(toolDefinition)`. The loader does
  `extension.tools.set(tool.name, …)` keyed by name (`pi-mono .../core/extensions/loader.ts:192`), so a
  `name:"edit"` tool **replaces** the built-in. **Precedent:** `@bravo/pi-extension-background-bash`
  overrides `bash` this exact way — `src/bash-tool.ts` registers `name:"bash"`, and `src/index.ts`
  verifies the override in a `before_agent_start` hook via `getActiveTools()/getAllTools()`.
- The `ToolDefinition` shape = upstream `createEditToolDefinition` in `edit.ts`
  (`name, label, description, promptSnippet, promptGuidelines, parameters (typebox), renderShell,
  prepareArguments, execute, renderCall, renderResult`). Reuse it, swapping in the new matcher, the lean
  contract strings (§3.1), and structured results (§3.2/3.3).
- Registration happens at **load** (before per-session context); verify the override **lazily** in
  `before_agent_start`. Gate registration behind config (mirror background-bash's `loadCfg.enabled`) so
  the override is opt-in and the built-in stays a fallback.

### 8.2 Placement

- **Recommended — package** `packages/pi-extension-edit/`, mirroring background-bash (package.json
  `"pi": { "extensions": ["./src/index.ts"] }`, `tsc` build, `node --test`). It carries the matcher + the
  ported unit suite, so it wants a package.
- **Lighter — project-local** `.pi/extensions/edit-tool.ts` (auto-discovered running `pi` from the repo,
  `/reload`-able). Fine for a single-file spike; the matcher + tests favor the package.

### 8.3 File layout (package option)

```
packages/pi-extension-edit/
  package.json          # "pi": { "extensions": ["./src/index.ts"] }; peerDeps: pi-coding-agent, pi-ai, typebox
  tsconfig.json
  src/
    index.ts            # default async (pi) => registerTool(createEditTool(cwd)); before_agent_start override-verify
    edit-tool.ts        # ToolDefinition name "edit": new contract strings + execute() + renderCall/renderResult
    edit-diff.ts        # ported matcher: scoped fuzzy + raw→final diff + fuzzy_ambiguous
    errors.ts           # structured envelope builders (JSON-in-text)
  test/
    matchers.test.ts    # port of harness/test_matchers.py (12 cases + the 2 gaps below)
```

### 8.4 Port steps (from the validated reference)

1. **Matcher → `src/edit-diff.ts`.** Start from upstream `edit-diff.ts`; apply what `matcher_new.py`
   encodes: (a) **scoped fuzzy** — build a normalized→raw index map line-by-line (trailing-ws strip at the
   line level only; per-char NFKC + quote/dash/space fold **without** per-char trailing-strip — the bug we
   fixed), map the fuzzy match back to its raw span, replace **only** that span; (b) compute the returned
   diff **raw-original → final** (not normalized→normalized) so any normalization is visible; (c) on an
   unmappable raw span, fail with structured `fuzzy_ambiguous`.
2. **Structured errors → `src/errors.ts`** per §3.2: `not_found {staleness?, read_range, near_misses[]}`,
   `not_unique {occurrence_count, occurrences[]}`, `overlap`, `no_change`, `empty`. Emit a compact JSON
   envelope in the tool-result text (pi results are text; JSON-in-text is parseable and is the reliable
   recovery signal).
3. **Tool def → `src/edit-tool.ts`** from upstream `edit.ts`: keep the wrapper responsibilities
   (`prepareArguments` incl. the JSON-string-edits accommodation, `withFileMutationQueue`, BOM strip, LF
   normalize, **restore line endings**); swap in the lean contract strings (§3.1), the new matcher, and a
   structured success result (`matches[]` + the fuzzy-normalization disclosure, §3.3).
4. **Registration → `src/index.ts`:** `pi.registerTool(createEditTool(cwd))`; replicate background-bash's
   `verifiedBashOverride()` as `verifiedEditOverride()` (exactly one active `edit`, sourced from this
   extension) and withhold/emit prompt guidance accordingly.
5. **Tests → `test/matchers.test.ts`:** port the 12 Python cases to `node:test`, keep the mutation-style
   guard (a test that reds if scoped-fuzzy regresses), and add the two gaps from ASSESSMENT: a
   BOM-on-the-target-line case, and an assertion that **CRLF restoration is the tool wrapper's job**, not
   the matcher (the matcher works in LF space).

### 8.5 Invariants to preserve in the port (don't lose these)

- Edits match the **original snapshot**, must be **disjoint**, applied reverse-offset.
- A fuzzy match **never** mutates outside the matched raw span; the diff is **raw→final**.
- **Line-ending restoration and BOM handling stay in the tool wrapper**, not the matcher.
- Keep the `prepareArguments` **JSON-string-edits** accommodation (a real model quirk, see `design.md` §2).

### 8.6 Acceptance (tomorrow)

- `npm -w @bravo/pi-extension-edit run build && node --test` green (12 ported + 2 new).
- Live `pi` from the repo: `/reload`; confirm the active `edit` is the override (verify-hook passes); a
  smoke edit with a repeated locator returns the structured `not_unique` occurrences; a fuzzy edit on a
  file with unrelated smart quotes preserves them (0 outside-span).
- The config toggle flips back to the built-in cleanly.

### 8.7 Scope for tomorrow vs later

- **Tomorrow (Phase 1):** the override extension with the scoped-fuzzy matcher, raw→final diff, structured
  `not_found`/`not_unique` envelopes, the lean contract strings, and the ported tests. The P1
  correctness + reliability win — fully specified and validated here.
- **Later (Phase 2/3):** revision-aware read/edit + `stale_snapshot` (needs a read-side hook to stamp
  revisions) and the optional `anchor`/`range` locator modes — eval-gated per §4. Not required tomorrow.
