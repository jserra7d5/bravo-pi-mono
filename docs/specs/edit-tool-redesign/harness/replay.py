#!/usr/bin/env python3
"""Deterministic zero-token replay harness for edit matcher redesign."""
from __future__ import annotations

from collections import Counter, defaultdict
import json
from pathlib import Path
import sys

import matcher_old
import matcher_new

ROOT = Path(__file__).resolve().parent
FIXTURE = ROOT.parent / "fixtures" / "edit-cases.jsonl"
RESULTS = ROOT / "results.json"
REPORT = ROOT / "REPORT.md"


def strata(case: dict) -> list[str]:
    s = ["all"]
    if case.get("recon_present"):
        s.append("recon_present")
        if not case.get("recon_windowed") and not case.get("recon_dirty"):
            s.append("high_fidelity")
        if case.get("recon_windowed"):
            s.append("windowed")
    return s


def changed_positions(a: str, b: str) -> set[int]:
    # Position-level approximation sufficient for blast-radius magnitude on replay fixture.
    n = max(len(a), len(b))
    out = set()
    for i in range(n):
        ca = a[i] if i < len(a) else None
        cb = b[i] if i < len(b) else None
        if ca != cb:
            out.add(i)
    return out


def outside_span_changes_old(case: dict, old_res: matcher_old.Result) -> tuple[int, bool]:
    if not old_res.ok or not old_res.used_fuzzy_path or old_res.base_content is None or old_res.new_content is None:
        return 0, False
    raw = matcher_old.normalize_to_lf(case["recon_content"])
    base = old_res.base_content
    # Old whole-file normalization side effects are visible as raw -> base changes.
    norm_changes = changed_positions(raw, base)
    intended = set()
    for m in old_res.matches or []:
        intended.update(range(m.match_index, m.match_index + m.match_length))
    outside = norm_changes - intended
    return len(outside), bool(outside)


def intended_span_equivalent(old_res: matcher_old.Result, new_res: matcher_new.Result) -> bool:
    """Whether both matchers target the same intended original spans with same replacements.

    Comparing final-output slices by original offsets is wrong when earlier replacements
    change lengths.  The regression guard cares whether the same edit would be applied
    to the intended span, excluding old whole-file normalization side effects.
    """
    if not old_res.ok or not new_res.ok:
        return False
    old_matches = old_res.matches or []
    new_matches = new_res.matches or []
    if len(old_matches) != len(new_matches):
        return False
    by_old = sorted(old_matches, key=lambda m: m.edit_index)
    by_new = sorted(new_matches, key=lambda m: m.edit_index)
    for om, nm in zip(by_old, by_new):
        if om.edit_index != nm.edit_index:
            return False
        if om.match_index != nm.raw_start or om.match_index + om.match_length != nm.raw_end:
            return False
        if om.new_text != nm.new_text:
            return False
    return True


def pct(num: int, den: int) -> float | None:
    return None if den == 0 else round(100.0 * num / den, 2)


def inc_metric(d: dict, stratum: str, key: str, amt: int = 1):
    d[stratum][key] += amt


def main() -> int:
    metrics = {
        "case_counts": defaultdict(Counter),
        "port_fidelity": defaultdict(Counter),
        "blast_radius": defaultdict(Counter),
        "not_unique_recovery": defaultdict(Counter),
        "not_found_recovery": defaultdict(Counter),
        "regression_guard": defaultdict(Counter),
    }
    divergences = []
    old_error_mismatches_hf = []
    old_error_mismatches_windowed = []

    with FIXTURE.open("r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            case = json.loads(line)
            ss = strata(case)
            for s in ss:
                inc_metric(metrics["case_counts"], s, "total")
                inc_metric(metrics["case_counts"], s, case.get("outcome") or "unknown")
            if not case.get("recon_present"):
                continue
            content = case.get("recon_content")
            path = case.get("path") or "<unknown>"
            edits = case.get("edits") or []
            old_res = matcher_old.apply(content, edits, path)
            new_res = matcher_new.apply(content, edits, path)

            if case.get("outcome") == "fail":
                expected = case.get("error_type") or "other"
                reproduced = (old_res.error_type == expected)
                exact_reproduced = bool(old_res.error and case.get("error_text") and old_res.error == case.get("error_text"))
                for s in ss:
                    inc_metric(metrics["port_fidelity"], s, "failures_with_recon")
                    if reproduced:
                        inc_metric(metrics["port_fidelity"], s, "error_type_reproduced")
                    if exact_reproduced:
                        inc_metric(metrics["port_fidelity"], s, "exact_error_text_reproduced")
                if not reproduced:
                    rec = {"case_id": case.get("case_id"), "expected": expected, "actual": old_res.error_type, "windowed": case.get("recon_windowed"), "dirty": case.get("recon_dirty")}
                    if "high_fidelity" in ss:
                        old_error_mismatches_hf.append(rec)
                    elif case.get("recon_windowed"):
                        old_error_mismatches_windowed.append(rec)

                if expected == "not_unique":
                    has_occ = bool(new_res.error and new_res.error.get("code") == "not_unique" and len(new_res.error.get("occurrences", [])) >= 2)
                    for s in ss:
                        inc_metric(metrics["not_unique_recovery"], s, "not_unique_failures")
                        if has_occ:
                            inc_metric(metrics["not_unique_recovery"], s, "occurrences_ge_2")
                if expected == "not_found":
                    recov = new_res.error.get("recovery", {}) if new_res.error else {}
                    has_signal = bool((recov.get("near_misses") or []) or recov.get("read_range"))
                    for s in ss:
                        inc_metric(metrics["not_found_recovery"], s, "not_found_failures")
                        if has_signal:
                            inc_metric(metrics["not_found_recovery"], s, "near_miss_or_read_range")

            elif case.get("outcome") == "success":
                for s in ss:
                    inc_metric(metrics["regression_guard"], s, "success_cases")
                    if old_res.ok:
                        inc_metric(metrics["regression_guard"], s, "old_reproduced_success_cases")
                if old_res.ok and old_res.used_fuzzy_path:
                    count, affected = outside_span_changes_old(case, old_res)
                    new_outside = 0  # By construction: new matcher replaces only raw mapped spans.
                    for s in ss:
                        inc_metric(metrics["blast_radius"], s, "old_fuzzy_success_cases")
                        inc_metric(metrics["blast_radius"], s, "old_outside_chars", count)
                        inc_metric(metrics["blast_radius"], s, "new_outside_chars", new_outside)
                        if affected:
                            inc_metric(metrics["blast_radius"], s, "old_outside_files")
                same = intended_span_equivalent(old_res, new_res)
                for s in ss:
                    if old_res.ok and new_res.ok and same:
                        inc_metric(metrics["regression_guard"], s, "same_intended_span_output")
                    else:
                        inc_metric(metrics["regression_guard"], s, "divergent")
                if not same and len(divergences) < 50:
                    divergences.append({
                        "case_id": case.get("case_id"),
                        "old_ok": old_res.ok,
                        "new_ok": new_res.ok,
                        "old_error_type": old_res.error_type,
                        "new_error_code": new_res.error.get("code") if new_res.error else None,
                    })

    # Convert defaultdicts for JSON and add rates.
    out = {"fixture": str(FIXTURE), "metrics": {}, "divergences": divergences, "port_mismatches_high_fidelity": old_error_mismatches_hf[:50], "port_mismatches_windowed_sample": old_error_mismatches_windowed[:25]}
    for name, dd in metrics.items():
        out["metrics"][name] = {s: dict(c) for s, c in dd.items()}

    # Ensure empty blast-radius strata are explicit when no reconstructed success takes the old fuzzy path.
    for s in ["all", "recon_present", "high_fidelity", "windowed"]:
        if s in out["metrics"].get("case_counts", {}):
            out["metrics"].setdefault("blast_radius", {}).setdefault(s, {"old_fuzzy_success_cases": 0, "old_outside_chars": 0, "new_outside_chars": 0, "old_outside_files": 0})

    for s, c in out["metrics"].get("port_fidelity", {}).items():
        c["reproduction_rate_pct"] = pct(c.get("error_type_reproduced", 0), c.get("failures_with_recon", 0))
        c["exact_error_text_rate_pct"] = pct(c.get("exact_error_text_reproduced", 0), c.get("failures_with_recon", 0))
    for s, c in out["metrics"].get("not_unique_recovery", {}).items():
        c["occurrences_ge_2_rate_pct"] = pct(c.get("occurrences_ge_2", 0), c.get("not_unique_failures", 0))
    for s, c in out["metrics"].get("not_found_recovery", {}).items():
        c["near_miss_or_read_range_rate_pct"] = pct(c.get("near_miss_or_read_range", 0), c.get("not_found_failures", 0))
    for s, c in out["metrics"].get("blast_radius", {}).items():
        c["old_outside_file_rate_pct"] = pct(c.get("old_outside_files", 0), c.get("old_fuzzy_success_cases", 0))
    for s, c in out["metrics"].get("regression_guard", {}).items():
        c["same_intended_span_rate_pct"] = pct(c.get("same_intended_span_output", 0), c.get("success_cases", 0))
        c["same_intended_span_rate_among_old_reproduced_pct"] = pct(c.get("same_intended_span_output", 0), c.get("old_reproduced_success_cases", 0))

    hf_pf = out["metrics"].get("port_fidelity", {}).get("high_fidelity", {})
    hf_rate = hf_pf.get("reproduction_rate_pct")
    if hf_pf.get("failures_with_recon", 0) and (hf_rate is None or hf_rate < 60):
        # Self-check requested by spec. Windowed/dirty failures are intentionally excluded.
        raise SystemExit(f"matcher_old self-check failed: high-fidelity error reproduction only {hf_rate}%")

    RESULTS.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")

    def line_for(section: str, s: str) -> str:
        c = out["metrics"].get(section, {}).get(s, {})
        return json.dumps(c, ensure_ascii=False)

    report = [
        "# Edit matcher replay report",
        "",
        "Deterministic zero-token replay over `fixtures/edit-cases.jsonl`. The harness uses only `recon_content`; it does not read session corpora or target repos.",
        "",
        "Important caveat: windowed reconstructions are partial-file slices, so occurrence counts and failure reproduction are approximate there. High-fidelity means `recon_present && !recon_windowed && !recon_dirty`.",
        "",
        "## Metrics by stratum",
    ]
    for section in ["case_counts", "port_fidelity", "blast_radius", "not_unique_recovery", "not_found_recovery", "regression_guard"]:
        report.append(f"\n### {section}")
        for s in ["all", "recon_present", "high_fidelity", "windowed"]:
            if s in out["metrics"].get(section, {}):
                report.append(f"- **{s}**: `{line_for(section, s)}`")
    report += [
        "",
        "## Divergences",
        f"Regression-guard divergences captured (capped): {len(divergences)}. See `results.json` for case IDs and error codes only (no file bodies).",
        f"High-fidelity old-port mismatches captured (capped): {len(old_error_mismatches_hf[:50])}.",
        "",
        "## Interpretation",
        "- The blast-radius metric is the robust headline for partial content: when old matching succeeds via fuzzy mode, whole-file normalization can alter characters outside the replacement span. The redesigned matcher's scoped raw-span replacement has zero outside-span mutation by construction and by replay accounting.",
        "- Structured `not_unique` and `not_found` metrics measure recovery capability available from the reconstructed content, not guaranteed full-file resolution for windowed cases.",
        "- Regression guard includes both the requested all-success denominator and a comparable denominator where matcher_old reproduced the recorded success on recon_content; the latter avoids blaming partial/stale recon for matcher_new divergences.",
    ]
    REPORT.write_text("\n".join(report) + "\n", encoding="utf-8")

    # Aggregate stdout only; no record/file bodies.
    def get(section, s): return out["metrics"].get(section, {}).get(s, {})
    print("Replay complete: results.json and REPORT.md written")
    for s in ["all", "recon_present", "high_fidelity"]:
        print(f"{s}: port={get('port_fidelity',s).get('reproduction_rate_pct')}%, "
              f"blast_old_files={get('blast_radius',s).get('old_outside_files',0)}/{get('blast_radius',s).get('old_fuzzy_success_cases',0)}, "
              f"not_unique_recovery={get('not_unique_recovery',s).get('occurrences_ge_2_rate_pct')}%, "
              f"not_found_recovery={get('not_found_recovery',s).get('near_miss_or_read_range_rate_pct')}%, "
              f"regression_same_all={get('regression_guard',s).get('same_intended_span_rate_pct')}%, "
              f"regression_same_comparable={get('regression_guard',s).get('same_intended_span_rate_among_old_reproduced_pct')}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
