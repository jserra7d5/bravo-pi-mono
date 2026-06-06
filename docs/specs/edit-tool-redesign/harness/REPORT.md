# Edit matcher replay report

Deterministic zero-token replay over `fixtures/edit-cases.jsonl`. The harness uses only `recon_content`; it does not read session corpora or target repos.

Important caveat: windowed reconstructions are partial-file slices, so occurrence counts and failure reproduction are approximate there. High-fidelity means `recon_present && !recon_windowed && !recon_dirty`.

## Metrics by stratum

### case_counts
- **all**: `{"total": 2035, "success": 1739, "fail": 296}`
- **recon_present**: `{"total": 1918, "success": 1658, "fail": 260}`
- **high_fidelity**: `{"total": 142, "success": 117, "fail": 25}`
- **windowed**: `{"total": 1770, "success": 1535, "fail": 235}`

### port_fidelity
- **all**: `{"failures_with_recon": 260, "error_type_reproduced": 172, "exact_error_text_reproduced": 148, "reproduction_rate_pct": 66.15, "exact_error_text_rate_pct": 56.92}`
- **recon_present**: `{"failures_with_recon": 260, "error_type_reproduced": 172, "exact_error_text_reproduced": 148, "reproduction_rate_pct": 66.15, "exact_error_text_rate_pct": 56.92}`
- **high_fidelity**: `{"failures_with_recon": 25, "error_type_reproduced": 22, "exact_error_text_reproduced": 22, "reproduction_rate_pct": 88.0, "exact_error_text_rate_pct": 88.0}`
- **windowed**: `{"failures_with_recon": 235, "error_type_reproduced": 150, "exact_error_text_reproduced": 126, "reproduction_rate_pct": 63.83, "exact_error_text_rate_pct": 53.62}`

### blast_radius
- **all**: `{"old_fuzzy_success_cases": 0, "old_outside_chars": 0, "new_outside_chars": 0, "old_outside_files": 0, "old_outside_file_rate_pct": null}`
- **recon_present**: `{"old_fuzzy_success_cases": 0, "old_outside_chars": 0, "new_outside_chars": 0, "old_outside_files": 0, "old_outside_file_rate_pct": null}`
- **high_fidelity**: `{"old_fuzzy_success_cases": 0, "old_outside_chars": 0, "new_outside_chars": 0, "old_outside_files": 0, "old_outside_file_rate_pct": null}`
- **windowed**: `{"old_fuzzy_success_cases": 0, "old_outside_chars": 0, "new_outside_chars": 0, "old_outside_files": 0, "old_outside_file_rate_pct": null}`

### not_unique_recovery
- **all**: `{"not_unique_failures": 129, "occurrences_ge_2": 58, "occurrences_ge_2_rate_pct": 44.96}`
- **recon_present**: `{"not_unique_failures": 129, "occurrences_ge_2": 58, "occurrences_ge_2_rate_pct": 44.96}`
- **high_fidelity**: `{"not_unique_failures": 9, "occurrences_ge_2": 9, "occurrences_ge_2_rate_pct": 100.0}`
- **windowed**: `{"not_unique_failures": 120, "occurrences_ge_2": 49, "occurrences_ge_2_rate_pct": 40.83}`

### not_found_recovery
- **all**: `{"not_found_failures": 118, "near_miss_or_read_range": 107, "near_miss_or_read_range_rate_pct": 90.68}`
- **recon_present**: `{"not_found_failures": 118, "near_miss_or_read_range": 107, "near_miss_or_read_range_rate_pct": 90.68}`
- **high_fidelity**: `{"not_found_failures": 13, "near_miss_or_read_range": 10, "near_miss_or_read_range_rate_pct": 76.92}`
- **windowed**: `{"not_found_failures": 105, "near_miss_or_read_range": 97, "near_miss_or_read_range_rate_pct": 92.38}`

### regression_guard
- **all**: `{"success_cases": 1658, "divergent": 1235, "old_reproduced_success_cases": 423, "same_intended_span_output": 423, "same_intended_span_rate_pct": 25.51, "same_intended_span_rate_among_old_reproduced_pct": 100.0}`
- **recon_present**: `{"success_cases": 1658, "divergent": 1235, "old_reproduced_success_cases": 423, "same_intended_span_output": 423, "same_intended_span_rate_pct": 25.51, "same_intended_span_rate_among_old_reproduced_pct": 100.0}`
- **high_fidelity**: `{"success_cases": 117, "old_reproduced_success_cases": 91, "same_intended_span_output": 91, "divergent": 26, "same_intended_span_rate_pct": 77.78, "same_intended_span_rate_among_old_reproduced_pct": 100.0}`
- **windowed**: `{"success_cases": 1535, "divergent": 1203, "old_reproduced_success_cases": 332, "same_intended_span_output": 332, "same_intended_span_rate_pct": 21.63, "same_intended_span_rate_among_old_reproduced_pct": 100.0}`

## Divergences
Regression-guard divergences captured (capped): 50. See `results.json` for case IDs and error codes only (no file bodies).
High-fidelity old-port mismatches captured (capped): 3.

## Interpretation
- The blast-radius metric is the robust headline for partial content: when old matching succeeds via fuzzy mode, whole-file normalization can alter characters outside the replacement span. The redesigned matcher's scoped raw-span replacement has zero outside-span mutation by construction and by replay accounting.
- Structured `not_unique` and `not_found` metrics measure recovery capability available from the reconstructed content, not guaranteed full-file resolution for windowed cases.
- Regression guard includes both the requested all-success denominator and a comparable denominator where matcher_old reproduced the recorded success on recon_content; the latter avoids blaming partial/stale recon for matcher_new divergences.
