# Edit tool redesign — empirically-grounded contract rewrite

**Status:** draft v0 (author critique + proposed rewrite, pending two external GPT-5.5 reviews)
**Target:** `packages/coding-agent/src/core/tools/edit.ts` and `edit-diff.ts` in the upstream pi-mono (`~/Documents/misc/pi-mono`)
**Author:** Claude (Opus 4.8), grounded in `behavior-shaping`, `prompt-design`, `context-engineering`
**Date:** 2026-06-05

---

## 1. Why this exists — the data

Analysis of **all 328 pi-agent session logs** (`~/.pi/agent/sessions`, reproducible via
`edit-failure-analysis.py` in this directory):

| metric | value |
|---|---|
| `edit` tool calls | **5,843** |
| succeeded | 5,547 |
| failed | 296 |
| **success rate** | **94.93%** (failure 5.07%) |

Failure taxonomy:

| kind | count | share of failures |
|---|---|---|
| `not_found` — oldText didn't match the file | 148 | 50.0% |
| `not_unique` — oldText matched 2+ places | 134 | 45.3% |
| `other` — no-op / overlap / schema | 14 | 4.7% |

For each failure I checked, **within the same session**, whether the failing sub-edit's `oldText`
had been surfaced before the edit (verbatim in a prior `read` of that file, or via
`ranked_search`/`grep`/`bash`/`write`). The two dominant modes have **opposite** root causes:

**`not_found` (148):** the model did *not* have the current exact text.
- only **4.1%** had the failing oldText verbatim in a prior read;
- **66.9%** had read a *different* part of the file;
- **60.1%** had already made a *successful* edit to that same file earlier in the turn — i.e. the
  file mutated after the model's last read and it matched a **stale snapshot**;
- **10.8%** were fully blind (never read, never surfaced).

**`not_unique` (134):** the model *did* have the text and under-specified the locator.
- **85.8%** had the exact oldText in a prior read;
- **0%** were blind.

**The headline (behavior-shaping: attribute to the harness first):** these failures are largely
**harness-authored, not model-authored**. The tool's own guidance optimizes for the smallness that
produces `not_unique`, and its own `not_found` error text misdirects recovery toward whitespace when
the real cause is usually a stale snapshot.

---

## 2. The current surface (what shapes the model today)

**Model-facing prompt surface** (`edit.ts`):
- `description` (`:299`): "Edit a single file using exact text replacement. Every edits[].oldText must
  match a unique, non-overlapping region of the original file. If two changes affect the same block
  or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include
  large unchanged regions just to connect distant changes."
- `promptGuidelines` (`:303-308`), 4 bullets — all restate schema constraints; #4 = "Keep
  edits[].oldText as small as possible while still being unique in the file."
- schema descriptions: `oldText` = "Exact text … must be unique … must not overlap"; `edits` =
  "matched against the original file, not incrementally …".

**Error surface** (`edit-diff.ts`):
- `not_found` (`:147`): "Could not find edits[i]. The oldText must match exactly **including all
  whitespace and newlines**."
- `not_unique` (`:158`): "Found N occurrences … Each oldText must be unique. Please provide more
  context to make it unique."
- `no_change` (`:176`): "… might indicate an issue with special characters or the text not existing
  as expected."
- `overlap` (`:240`), `empty` (`:169`).

**Behavior surface** (`edit-diff.ts`): exact `indexOf`, then a **fuzzy** fallback that NFKC-normalizes,
strips trailing whitespace per line, and folds smart quotes / Unicode dashes / special spaces
(`:34-55`). Uniqueness is counted in **fuzzy space** (`:141`). All edits match the **original**
snapshot and apply reverse-offset (`:209-253`).

---

## 3. Three-lens critique (author, v0)

### 3.1 behavior-shaping

- **The guidance weights the dice toward `not_unique` (misweighted rule, triage category 4).**
  "Keep oldText as small as possible" (`oldText` desc + guideline #4) makes locators *more* likely to
  be non-unique. 45% of all failures are `not_unique`, and 86% of those had already *read* the exact
  text — they saw it and under-specified because the contract told them to minimize. Re-weight the
  principle; don't add a rule.
- **The `not_found` error mis-teaches recovery (wrong reflection signal).** It blames whitespace;
  the data says 60% are stale snapshots. behavior-shaping: a reflection/recovery loop only helps with
  a *reliable* signal. The tool just re-read the file (`edit.ts:339`) and could hand back a reliable
  one ("file changed since you read it — re-read" and/or the nearest near-miss). Today it hands back a
  misleading one.
- **Frequency gate is cleared and the eval set already exists** — the 5,843-call corpus. Every change
  below is a hypothesis until replayed pre/post (§6).
- **Done-right precedent:** the JSON-string-edits accommodation (`edit.ts:100-106`) is a model quirk
  worked around *in the harness* — the right instinct, reused below.

### 3.2 prompt-design

- **Behaviors, not principles.** All four guidelines are symptoms. The single unifying principle —
  *oldText is a locator that must unambiguously and currently identify exactly one region* — is never
  stated. Name it once and the model derives the rest and resolves the small-vs-unique tension itself.
- **Restate-for-emphasis.** The overlap/merge rule appears 3× (description + `edits` desc + guideline
  #3); small/unique appears 3×. Pure token cost on every advertisement; consolidate to one owner each.
- **The highest-value content is missing.** No selection prior for the read→edit coupling, no
  staleness guidance — the single biggest `not_found` driver has zero coverage. And a demonstrably
  high-error tool ships with **zero examples**; prompt-design treats steered self-correction examples
  as the top device for high-error tools.
- **Prompt-vs-implementation contradiction + a hidden side effect.** Everything says "exact … all
  whitespace," but the matcher is fuzzy. Worse: when *any* edit falls back to fuzzy, `baseContent`
  becomes the fuzzy-normalized **whole file** (`edit-diff.ts:210-212`) and that is what's written
  (`edit.ts:350`) — a single fuzzy edit silently ASCII-fies every smart quote / em-dash / NBSP in the
  file. Because the returned diff compares normalized→normalized (`:354`), **the model cannot see it**.

### 3.3 context-engineering

- **Tool-presentation contract gaps.** Against the 8-point checklist the tool is missing examples,
  reasoning traces, and structured guidance (`use_when`/`avoid_when`/`invariants`/`fallback`). The two
  load-bearing invariants ("edits match the original snapshot"; "a fuzzy match normalizes the whole
  file") belong in `invariants`.
- **Static vs runtime tiering / lazy disclosure.** The staleness nudge should live in the **error
  envelope** (runtime tier, paid only when a `not_found` actually fires), not bloat the always-on
  `description`.
- **No observation-driven anti-pattern catalog.** We have the traces; the two dominant patterns should
  be a 2-line catalog with *why*, and the top one escalated to a steered example.
- **Single-source-of-truth.** Kill the double/triple documentation: schema fields own parameter
  constraints; `description` owns the one-sentence purpose; `promptGuidelines` own methodology.

---

## 4. Proposed rewrite (v0 — copy-paste-ready)

### 4.1 `description` (one-sentence purpose; constraints move to schema)

```
Edit one file by replacing exact text regions. Each edits[].oldText is a locator: it must identify
exactly one region of the file as it exists on disk right now. Batch multiple disjoint replacements
in a single call.
```

### 4.2 `promptSnippet`

```
Replace exact text regions in one file; batch multiple disjoint edits in one call.
```

### 4.3 `promptGuidelines` (each teaches one distinct thing; no restatements)

```
1. oldText is a locator. It must identify exactly one region of the current file. Make it long enough
   to be unambiguous, short enough to read, and copy it from text you have actually seen.
2. Anchor on a fresh read. If you have already edited this file in this turn, its contents changed —
   re-read the target region before editing again; your earlier copy is stale. (This is the single
   most common cause of a failed edit.)
3. When a minimal span repeats, extend oldText with one adjacent anchor (the enclosing signature, a
   heading, a unique token) until it matches exactly once. Prefer one unique anchor over a large block.
4. To change several places at once, send one call with multiple edits[]. Each is matched against the
   original file independently, so keep them disjoint and non-overlapping.
```

### 4.4 schema field descriptions (single source of truth for constraints)

```
path:    Path to the file to edit (relative to cwd, or absolute).
edits:   One or more replacements applied to a single file. Each edit is matched against the original
         file content — not the result of earlier edits in the same call — so edits must target
         disjoint, non-overlapping regions. Batch separate changes here instead of making multiple
         edit calls.
oldText: The exact text to locate and replace. It must match the current file content and be unique
         within it. Matching tolerates trailing whitespace and common Unicode variants (smart quotes,
         en/em dashes, non-breaking spaces); all other differences must match exactly. If the text is
         not unique, include an adjacent anchor line to disambiguate.
newText: The text to write in place of oldText.
```

### 4.5 error strings (teaching surfaces with actionable recovery)

```
not_found (multi):
  Could not find edits[{i}] in {path}: oldText did not match the file's current content. If you
  edited this file earlier in this turn, it has changed — re-read {path} and copy oldText from the
  fresh content before retrying. (Trailing whitespace and smart quotes/dashes are already tolerated,
  so the difference is elsewhere — usually a stale snapshot or the wrong region.)
  [enhancement] Closest near-miss: lines {a}-{b}.

not_unique (multi):
  Found {n} occurrences of edits[{i}] in {path}: oldText must identify exactly one region. Extend it
  with an adjacent anchor (the enclosing function/heading line, or a nearby unique token) so it
  matches only the region you intend.

no_change:
  No changes made to {path}: edits[{i}].oldText and newText are identical after normalization — this
  edit is a no-op. If you intended a change, the text you meant to alter may differ from oldText.

overlap:
  edits[{a}] and edits[{b}] overlap in {path}. Each oldText is matched against the original file, so
  overlapping regions cannot both apply. Merge them into one edit, or target disjoint regions.
```

### 4.6 success result — surface fuzzy normalization (correctness/transparency)

```
Successfully replaced {n} block(s) in {path}.
[when any edit used fuzzy match]
  Note: matched with normalization — trailing whitespace and Unicode punctuation (smart quotes,
  dashes, non-breaking spaces) elsewhere in this file may have been rewritten to ASCII. Review the
  diff if the file intentionally uses those characters.
```

### 4.7 examples (steered self-correction; first-person; one per distinct pattern)

```
Example A — disambiguate a repeated locator (targets not_unique, 45% of failures)
  Reasoning: I want to change the second `timeout: 30` in config.ts. The minimal span `timeout: 30`
  appears three times, so it is not a unique locator. I'll anchor on the enclosing key.
  edit(path="config.ts", edits=[{ oldText: "retry:\n    timeout: 30", newText: "retry:\n    timeout: 60" }])
  Reasoning after: Matched exactly one region. If it were still ambiguous I'd extend up to the section
  header rather than guess — I would not shorten it.

Example B — re-read between successive edits (targets not_found stale-snapshot, 60% of that mode)
  Reasoning: I already edited utils.ts once this turn (replaced the import block). I now want to change
  a function lower down, but my copy of the file predates that edit, so nearby text may have shifted.
  I'll re-read the region first.
  read(path="utils.ts", offset=…); edit(path="utils.ts", edits=[…copied from the fresh read…])
  Reasoning after: Editing from freshly-read text avoids the "could not find" failure that a stale
  snapshot causes.
```

### 4.8 anti-pattern catalog (observation-driven, with *why* + *instead*)

```
- Under-specified locator. Why: minimal spans recur; 86% of not_unique failures had read the exact
  text yet chose too little context. Instead: add one unique anchor line.
- Editing from a stale snapshot. Why: 60% of not_found failures hit a file already edited that turn;
  the model matched pre-edit text. Instead: re-read between successive edits to the same file.
- Chasing whitespace on a not_found. Why: the matcher already tolerates trailing whitespace and
  Unicode variants; the real cause is usually staleness or the wrong region. Instead: re-read.
- Padding oldText with large unchanged blocks "to be safe." Why: bloats tokens and raises overlap
  risk without improving uniqueness. Instead: one short anchor.
```

### 4.9 optional tool-layer affordances (behavior, beyond the prompt)

1. **Staleness guard:** track the last-read version per `(session, path)`; if an edit targets a file
   not read since its last mutation, prepend the re-read hint (and/or soft-fail).
2. **Near-miss locator on `not_found`:** return the closest fuzzy partial (first+last anchor line, or
   longest common run) with line numbers — a *reliable* recovery signal.
3. **Scope fuzzy normalization to the matched region** so one fuzzy edit can't rewrite the whole file;
   and compute the returned diff raw-original → final-written so any normalization is visible.
4. **Consider an anchor/line-range alternative** (or an explicit `expectedCount`) for genuinely
   repeated text, instead of forcing ever-larger oldText.

---

## 5. Open tensions (for the two external reviews to resolve)

1. **Prompt rot vs. teaching.** Does adding examples + an anti-pattern catalog to a *per-call* tool
   surface earn its tokens, or is it bloat a frontier model doesn't need? Where is the line between
   prompt-design's "examples for high-error tools" and behavior-shaping's "prompt rot"?
2. **Layer.** How much belongs in the prompt vs. the tool (staleness guard, near-miss, scoped
   normalization, anchor-based edits)? Is the exact-string locator paradigm itself the root fragility?
3. **Re-weighting risk.** "Smallest *unambiguous*" lengthens oldText — does that inflate `not_found`
   (more surface to go stale/wrong)? The two modes trade off; the net must be measured, not assumed.
4. **Tiering.** Should the staleness nudge be runtime-only (error envelope, lazy) or also always-on
   guidance? What's the minimal always-on surface?

---

## 6. Validation plan

Replay the **282 substantive failures** + a sample of the 5,547 successes against the rewritten
contract and matcher:
- target metric: `not_unique` ↓ **without** `not_found` ↑ (and overall success ↑);
- guard metric: no regression on currently-successful edits;
- per behavior-shaping eval-driven-iteration: target / adjacent / distant case mix; multi-run where
  the change is judgment-shaped.
Corpus + script: `~/.pi/agent/sessions` + `edit-failure-analysis.py` (this directory).
```
