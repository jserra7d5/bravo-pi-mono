# Track A harness — independent assessment

Built by a pi/gpt-5.5 (medium) builder; re-run and verified independently. The harness is deterministic
and costs **zero LLM tokens** to run. Files: `matcher_old.py` (faithful port of `edit-diff.ts`),
`matcher_new.py` (proposed redesign), `replay.py` (→ `results.json`, `REPORT.md`),
`blast_radius_demo.py` (synthetic correctness demo). Fixture: `../fixtures/edit-cases.jsonl`.

## What replay shows (re-run reproduces these exactly)

| metric | all | high-fidelity¹ | reading |
|---|---|---|---|
| port fidelity (old reproduces recorded error) | 66% | **88% (22/25)** | the old-matcher port is faithful |
| not_unique → structured `occurrences[]` (≥2) | 45% | **100% (9/9)** | capability proven; windowed recon undercounts |
| not_found → near-miss/`read_range` computable | 91% | 77% | structured recovery available in most cases |
| regression (new == old on intended span) | 100% on comparable² | 100% | **no regression on the exact-match path** |
| correctness-bug blast radius | **0/0 — unmeasurable** | 0/0 | see below |

¹ `recon_present && !recon_windowed && !recon_dirty` (~25 failures). ² Among the 423 successes whose
content was faithful enough for the old matcher to reproduce the success; all 423 match. The other
~1,235 "divergences" are recon-fidelity artifacts (old itself can't reproduce them on partial content),
not real regressions.

## Two findings the corpus replay could NOT surface (caught by independent testing)

**1. Blast-radius frequency is unmeasurable from this corpus.** Of 1,739 sampled successes, **0 take the
old fuzzy path** when replayed on `recon_content` (1,235 reproduce as `not_found` because windowed reads
lack the text; 423 reproduce as exact-match successes). The fuzzy path only fires when the full
surrounding text is present, which windowed reconstructions don't have. So the bug's real-world
frequency stays unknown. It is, however, real by construction — `blast_radius_demo.py` triggers it
synthetically: on a fuzzy edit, the **old** matcher silently rewrites unrelated lines (smart quotes
`“Hello”`→`"Hello"`, trailing whitespace stripped) **outside** the edit span.

**2. The proposed `matcher_new` had a fuzzy-mapping defect — now FIXED.** It built its normalized→raw
index map **per character**; `_char_fuzzy(" ") == ""` (single-space trailing-strip), so
`normalize_with_map("  return 'hi';")` → `"return'hi';"` — every space was destroyed, while the real
`normalizeForFuzzyMatch` strips only *trailing* whitespace per line. Consequence: the new matcher failed
to fuzzy-match almost any spaced `oldText` and fell back to `not_found`. Its "zero outside-span
mutation by construction" held in replay only because **it never matched a fuzzy case** (all 0 of them).

**Fix (applied):** `normalize_with_map` now strips trailing whitespace at the line level only, and
normalizes each remaining character via `_char_norm` (NFKC + quote/dash/space folding, *no*
trailing-strip), preserving interior/leading spaces. `blast_radius_demo.py` now shows NEW applying the
fuzzy edit cleanly with **0 outside-span mutation** while OLD mutates 2 unrelated lines; `replay.py`
regression-on-comparable stays 100% (exact path untouched). The scoped-fuzzy *design* was sound; only
the map construction was wrong.

## Verdict

- The harness is sound and the **old-matcher port is faithful** (88% high-fidelity error reproduction).
- The **whole-file-normalization bug is confirmed** (synthetically); its corpus frequency is unmeasurable
  here — that needs full-file content the corpus doesn't retain, or a unit-test suite over crafted inputs.
- The **structured-recovery capability is validated** (not_unique 100% high-fidelity; not_found ~77–91%).
- **No regression on the exact-match path.**
- **`matcher_new`'s fuzzy path needs a fix** before it can be trusted; this is the priority for the next
  iteration (and a required behavior of the eventual TypeScript implementation). — **DONE** (see finding #2).

## Unit suite (`test_matchers.py`)

A crafted stdlib-`unittest` suite (12 tests, pi/gpt-5.5-built, independently verified) covers what the
corpus structurally cannot: exact parity old↔new, multi-edit disjoint/reverse-offset, overlap, not_found
+ not_unique structured envelopes, no-op, empty oldText, fuzzy (smart quotes / en+em dash / NBSP /
trailing ws), the **scoped-fuzzy invariant** (test 09: new preserves unrelated curly quotes/NBSP/trailing
spaces while old normalizes the whole file), CRLF, BOM, and leading/interior-whitespace through fuzzy
mapping (test 12). **12/12 pass** with the fix in place.

**Teeth verified by mutation:** re-introducing the original per-char normalization bug turns exactly the
three fuzzy tests (08, 09, 12) red and leaves the exact-path tests green — the suite genuinely guards the
fix, not a coincidental pass.

Two coverage caveats for the eventual TS implementation (both intentional at matcher level):
- **CRLF restoration is NOT the matcher's job** (test 10 asserts LF-space output); the real `edit.ts`
  restores line endings in the tool wrapper — keep that responsibility split.
- **BOM coverage is shallow** (test 11 edits a non-BOM line); add a case that edits the BOM-bearing first
  line when porting to TS.
