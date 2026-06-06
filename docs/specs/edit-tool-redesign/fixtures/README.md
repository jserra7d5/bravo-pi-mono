# `edit-cases.jsonl` — replay fixture

Produced by `../distill-corpus.py` from the pi session corpus (`~/.pi/agent/sessions`, ~470 MB).
**Zero LLM tokens.** Self-contained: the replay harness needs NO access to the corpus or to any repo
on disk — every case carries its own reconstructed content. **Do not read the 470 MB corpus.**

One JSON object per line. 2,035 records = 296 failures (148 not_found, 134 not_unique, 8 no_change,
4 overlap, 2 other) + 1,739 successes (fuzzy-suspects + a 1-in-8 sample, for correctness/regression).

## Fields

| field | meaning |
|---|---|
| `case_id` | `<session-file>#<line-index>` |
| `session` | session path (provenance only) |
| `path` | the file the edit targeted (string as the agent passed it; do NOT open it on disk) |
| `outcome` | `"fail"` or `"success"` |
| `error_type` | for failures: `not_found` / `not_unique` / `no_change` / `overlap` / `empty` / `other` |
| `fail_edit_index` | index `N` parsed from `edits[N]` in the error (may be `null` for single-edit errors) |
| `error_text` | the exact recorded error string (ground truth for port-fidelity checks) |
| `edits` | the recorded `[{oldText, newText}, …]` the model submitted |
| `recon_content` | **reconstructed edit-time file content** — see fidelity below — or `null` |
| `recon_present` | `recon_content` is non-null |
| `recon_windowed` | the source `read` used `offset`/`limit`, so `recon_content` is a PARTIAL slice |
| `recon_rolled_forward` | content was rolled forward through ≥1 prior successful edit on this path |
| `recon_dirty` | a roll-forward replacement could not be located → lower fidelity |
| `recon_truncated` | content was capped at 262,144 chars |
| `exact_oldtext_in_recon` | whether the probed `oldText` appears verbatim in `recon_content` (`null` if no recon) |

## Reconstruction & fidelity (read before interpreting results)

`recon_content` = the nearest preceding successful `read` of `path` in the same session, rolled forward
through intervening successful edits (best-effort `str.replace`). Limitations:

- **235/260 reconstructed failures came from WINDOWED reads** → partial-file content. Occurrence counts
  and "not found" reproductions are therefore APPROXIMATE vs. the real full file. Stratify by
  `recon_windowed == false` for the high-fidelity subset (~25 failures).
- `recon_dirty == true` (39 failures): roll-forward missed a replacement; treat as low fidelity.
- 36 failures have no recon at all (`recon_present == false`) — cannot be replayed.

**Therefore:** lead with results that are robust to partial content — the whole-file-normalization
correctness bug (deterministic on whatever content is present) and the structured-error *capability*
(occurrences/near-miss are demonstrable) — and report full-file resolution *rates* only as
fidelity-stratified estimates, clearly labelled.
