"""Redesigned edit matcher: current matching semantics plus scoped fuzzy fixes.

Exact/uniqueness semantics intentionally match the old matcher's fuzzy search space,
but fuzzy replacement maps the normalized match back to a raw LF-normalized span and
replaces only that span.  Failures return structured recovery envelopes.
"""
from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher
import json
import unicodedata
import matcher_old


@dataclass
class Match:
    edit_index: int
    raw_start: int
    raw_end: int
    norm_start: int
    norm_end: int
    new_text: str
    match_kind: str


@dataclass
class Result:
    ok: bool
    new_content: str | None = None
    matches: list[Match] | None = None
    error: dict | None = None
    error_text: str | None = None


def normalize_to_lf(text: str) -> str:
    return matcher_old.normalize_to_lf(text)


def _build_fuzzy_trans() -> dict[int, str]:
    trans = {
        0x2018: "'", 0x2019: "'", 0x201A: "'", 0x201B: "'",
        0x201C: '"', 0x201D: '"', 0x201E: '"', 0x201F: '"',
        0x2010: "-", 0x2011: "-", 0x2012: "-", 0x2013: "-",
        0x2014: "-", 0x2015: "-", 0x2212: "-",
        0x00A0: " ", 0x202F: " ", 0x205F: " ", 0x3000: " ",
    }
    for cp in range(0x2002, 0x200B):
        trans[cp] = " "
    return trans


_FUZZY_TRANS = _build_fuzzy_trans()


def _char_norm(c: str) -> str:
    """Per-character fuzzy normalization that mirrors matcher_old.normalize_for_fuzzy_match's
    NFKC + quote/dash/space folding, but WITHOUT trailing-whitespace stripping. Trailing-ws is a
    per-line operation handled in normalize_with_map; doing it per character (as the old _char_fuzzy
    did via normalize_for_fuzzy_match) deleted every interior/leading space and broke fuzzy mapping.
    (Caveat: NFKC is applied per character, so the rare combining-sequence case may differ from the
    whole-string normalization used for the needle; immaterial for code/text edits.)"""
    return unicodedata.normalize("NFKC", c).translate(_FUZZY_TRANS)


def normalize_with_map(text: str) -> tuple[str, list[tuple[int, int]]]:
    """Return fuzzy-normalized text plus normalized char -> raw span map.

    This mirrors normalizeForFuzzyMatch for practical replay purposes while keeping
    every emitted normalized character tied to the raw character span that produced it.
    Characters removed by trailing-whitespace stripping simply produce no map entry.
    """
    out: list[str] = []
    mp: list[tuple[int, int]] = []
    n = len(text)
    line_start = 0
    while line_start <= n:
        nl = text.find("\n", line_start)
        if nl == -1:
            line_end = n
            has_nl = False
        else:
            line_end = nl
            has_nl = True
        # trim Python/JS-style trailing whitespace sufficiently for corpus replay
        trim_end = line_end
        while trim_end > line_start and text[trim_end - 1].isspace() and text[trim_end - 1] != "\n":
            trim_end -= 1
        for i in range(line_start, trim_end):
            norm = _char_norm(text[i])
            for ch in norm:
                out.append(ch)
                mp.append((i, i + 1))
        if has_nl:
            out.append("\n")
            mp.append((nl, nl + 1))
            line_start = nl + 1
        else:
            break
    return "".join(out), mp


def line_no(content: str, index: int) -> int:
    return content.count("\n", 0, max(0, min(index, len(content)))) + 1


def snippet_context(content: str, start: int, end: int) -> dict:
    lines = content.split("\n")
    ls = line_no(content, start)
    le = line_no(content, end)
    def get_line(n: int) -> str:
        if 1 <= n <= len(lines):
            return lines[n - 1][:160]
        return ""
    match = content[start:end]
    return {
        "line_start": ls,
        "line_end": le,
        "before": get_line(ls - 1),
        "match": match[:240],
        "after": get_line(le + 1),
    }


def _occurrence_raw_spans(content: str, old_text: str) -> tuple[str, list[tuple[int, int, int, int]], bool]:
    exact_spans = []
    pos = content.find(old_text)
    while pos != -1:
        exact_spans.append((pos, pos + len(old_text), pos, pos + len(old_text)))
        pos = content.find(old_text, pos + 1)
    if exact_spans:
        return "exact", exact_spans, False

    norm_content, mp = normalize_with_map(content)
    norm_old = matcher_old.normalize_for_fuzzy_match(old_text)
    spans = []
    if norm_old == "":
        return "fuzzy", [], False
    pos = norm_content.find(norm_old)
    ambiguous = False
    while pos != -1:
        end = pos + len(norm_old)
        if end <= len(mp) and pos < end:
            raw_start = mp[pos][0]
            raw_end = mp[end - 1][1]
            if raw_start <= raw_end:
                spans.append((raw_start, raw_end, pos, end))
            else:
                ambiguous = True
        else:
            ambiguous = True
        pos = norm_content.find(norm_old, pos + 1)
    return "fuzzy", spans, ambiguous


def _not_found(path: str, edit_index: int, content: str, old_text: str) -> dict:
    near = []
    content_lines = content.split("\n")
    # Cheap deterministic near-miss heuristic: score only lines sharing a distinctive
    # token with oldText, capped to keep replay bounded and stdout/file-body safe.
    tokens = [t for t in matcher_old.normalize_for_fuzzy_match(old_text).replace("\n", " ").split() if len(t) >= 4]
    token_set = set(tokens[:20])
    candidates = []
    if token_set:
        for i, line in enumerate(content_lines[:5000]):
            norm_line = matcher_old.normalize_for_fuzzy_match(line)
            if any(t in norm_line for t in token_set):
                score = SequenceMatcher(None, " ".join(tokens[:40]), norm_line[:500]).ratio()
                candidates.append((score, i + 1, i + 1, line[:240]))
                if len(candidates) >= 200:
                    break
    for score, ls, le, prev in sorted(candidates, reverse=True)[:5]:
        near.append({"line_start": ls, "line_end": min(le, len(content_lines)), "score": round(score, 3), "preview": prev})
    rr = {"path": path, "offset": max(1, near[0]["line_start"] - 5), "limit": 30} if near else ({"path": path, "offset": 1, "limit": 30} if content else None)
    return {
        "code": "not_found",
        "path": path,
        "edit_index": edit_index,
        "message": "oldText did not match the file's current content.",
        "suggested_action": "read_range_and_retry",
        "recovery": {"staleness": None, "read_range": rr, "near_misses": near},
    }


def _not_unique(path: str, edit_index: int, content: str, spans: list[tuple[int, int, int, int]]) -> dict:
    occs = []
    for n, (s, e, _ns, _ne) in enumerate(spans[:20], 1):
        ctx = snippet_context(content, s, e)
        ctx["occurrence"] = n
        occs.append(ctx)
    return {
        "code": "not_unique",
        "path": path,
        "edit_index": edit_index,
        "occurrence_count": len(spans),
        "message": f"oldText matches {len(spans)} regions; it must identify exactly one.",
        "suggested_action": "retry_with_adjacent_anchor_from_target_occurrence",
        "occurrences": occs,
    }


def _simple_error(code: str, path: str, edit_index: int | None, message: str, action: str) -> dict:
    d = {"code": code, "path": path, "message": message, "suggested_action": action}
    if edit_index is not None:
        d["edit_index"] = edit_index
    return d


def _json_err(envelope: dict) -> str:
    return json.dumps(envelope, ensure_ascii=False, separators=(",", ":"))


def apply(content: str, edits: list[dict], path: str) -> Result:
    content = normalize_to_lf(content)
    norm_edits = [{"oldText": normalize_to_lf(e.get("oldText", "")), "newText": normalize_to_lf(e.get("newText", ""))} for e in edits]
    total = len(norm_edits)
    for i, e in enumerate(norm_edits):
        if e["oldText"] == "":
            env = _simple_error("empty", path, i, "oldText must not be empty.", "provide_non_empty_oldText")
            return Result(False, error=env, error_text=_json_err(env))

    matched: list[Match] = []
    for i, e in enumerate(norm_edits):
        kind, spans, ambiguous = _occurrence_raw_spans(content, e["oldText"])
        if ambiguous:
            env = _simple_error("fuzzy_ambiguous", path, i, "Fuzzy match could not be mapped unambiguously to a raw span.", "retry_with_exact_current_text")
            env["candidates"] = [snippet_context(content, s, en) for s, en, _ns, _ne in spans[:10]]
            return Result(False, error=env, error_text=_json_err(env))
        if not spans:
            env = _not_found(path, i, content, e["oldText"])
            return Result(False, error=env, error_text=_json_err(env))
        # old matcher counts in fuzzy space even after base normalization; this is equivalent for locators.
        if len(spans) > 1:
            env = _not_unique(path, i, content, spans)
            return Result(False, error=env, error_text=_json_err(env))
        s, en, ns, ne = spans[0]
        matched.append(Match(i, s, en, ns, ne, e["newText"], kind))

    matched.sort(key=lambda m: m.raw_start)
    for i in range(1, len(matched)):
        prev, cur = matched[i - 1], matched[i]
        if prev.raw_end > cur.raw_start:
            env = _simple_error("overlap", path, cur.edit_index, f"edits[{prev.edit_index}] and edits[{cur.edit_index}] overlap.", "merge_or_disjoint")
            return Result(False, matches=matched, error=env, error_text=_json_err(env))

    new_content = content
    for m in reversed(matched):
        new_content = new_content[:m.raw_start] + m.new_text + new_content[m.raw_end:]
    if new_content == content:
        env = _simple_error("no_change", path, None, "The replacement produced identical content.", "skip_or_change_replacement")
        return Result(False, matches=matched, error=env, error_text=_json_err(env))
    return Result(True, new_content=new_content, matches=matched)
