"""Faithful Python port of the current pi edit matcher (edit-diff.ts).

This module is intentionally self-contained and operates on in-memory reconstructed
content only.  It mirrors the current matcher behavior: exact search first, then
fuzzy search in whole-file normalized space; if any edit initially needs fuzzy
matching, all replacements are applied to the whole-file normalized base.
"""
from __future__ import annotations

from dataclasses import dataclass
import unicodedata


@dataclass
class Edit:
    oldText: str
    newText: str


@dataclass
class Match:
    edit_index: int
    match_index: int
    match_length: int
    new_text: str
    used_fuzzy: bool


@dataclass
class Result:
    ok: bool
    base_content: str | None = None
    new_content: str | None = None
    matches: list[Match] | None = None
    used_fuzzy_path: bool = False
    error: str | None = None
    error_type: str | None = None
    edit_index: int | None = None


def normalize_to_lf(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def normalize_for_fuzzy_match(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    text = "\n".join(line.rstrip() for line in text.split("\n"))
    trans = {
        ord("\u2018"): "'", ord("\u2019"): "'", ord("\u201A"): "'", ord("\u201B"): "'",
        ord("\u201C"): '"', ord("\u201D"): '"', ord("\u201E"): '"', ord("\u201F"): '"',
        ord("\u2010"): "-", ord("\u2011"): "-", ord("\u2012"): "-", ord("\u2013"): "-",
        ord("\u2014"): "-", ord("\u2015"): "-", ord("\u2212"): "-",
        ord("\u00A0"): " ", ord("\u202F"): " ", ord("\u205F"): " ", ord("\u3000"): " ",
    }
    for cp in range(0x2002, 0x200B):
        trans[cp] = " "
    return text.translate(trans)


def fuzzy_find_text(content: str, old_text: str) -> tuple[bool, int, int, bool, str]:
    exact_index = content.find(old_text)
    if exact_index != -1:
        return True, exact_index, len(old_text), False, content
    fuzzy_content = normalize_for_fuzzy_match(content)
    fuzzy_old = normalize_for_fuzzy_match(old_text)
    fuzzy_index = fuzzy_content.find(fuzzy_old)
    if fuzzy_index == -1:
        return False, -1, 0, False, content
    return True, fuzzy_index, len(fuzzy_old), True, fuzzy_content


def count_occurrences(content: str, old_text: str) -> int:
    fuzzy_content = normalize_for_fuzzy_match(content)
    fuzzy_old = normalize_for_fuzzy_match(old_text)
    if fuzzy_old == "":
        return 0
    return fuzzy_content.count(fuzzy_old)


def _not_found(path: str, edit_index: int, total: int) -> str:
    if total == 1:
        return f"Could not find the exact text in {path}. The old text must match exactly including all whitespace and newlines."
    return f"Could not find edits[{edit_index}] in {path}. The oldText must match exactly including all whitespace and newlines."


def _duplicate(path: str, edit_index: int, total: int, occurrences: int) -> str:
    if total == 1:
        return f"Found {occurrences} occurrences of the text in {path}. The text must be unique. Please provide more context to make it unique."
    return f"Found {occurrences} occurrences of edits[{edit_index}] in {path}. Each oldText must be unique. Please provide more context to make it unique."


def _empty(path: str, edit_index: int, total: int) -> str:
    if total == 1:
        return f"oldText must not be empty in {path}."
    return f"edits[{edit_index}].oldText must not be empty in {path}."


def _no_change(path: str, total: int) -> str:
    if total == 1:
        return f"No changes made to {path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected."
    return f"No changes made to {path}. The replacements produced identical content."


def _etype(message: str) -> str:
    if message.startswith("Could not find"):
        return "not_found"
    if message.startswith("Found "):
        return "not_unique"
    if "overlap" in message:
        return "overlap"
    if message.startswith("No changes"):
        return "no_change"
    if "oldText must not be empty" in message:
        return "empty"
    return "other"


def apply_edits_to_normalized_content(normalized_content: str, edits: list[dict], path: str) -> Result:
    normalized_edits = [Edit(normalize_to_lf(e.get("oldText", "")), normalize_to_lf(e.get("newText", ""))) for e in edits]
    total = len(normalized_edits)
    for i, edit in enumerate(normalized_edits):
        if len(edit.oldText) == 0:
            msg = _empty(path, i, total)
            return Result(False, error=msg, error_type=_etype(msg), edit_index=i)

    initial = [fuzzy_find_text(normalized_content, e.oldText) for e in normalized_edits]
    used_fuzzy_path = any(m[3] for m in initial)
    base_content = normalize_for_fuzzy_match(normalized_content) if used_fuzzy_path else normalized_content

    matched: list[Match] = []
    for i, edit in enumerate(normalized_edits):
        found, idx, length, used_fuzzy, _ = fuzzy_find_text(base_content, edit.oldText)
        if not found:
            msg = _not_found(path, i, total)
            return Result(False, base_content=base_content, error=msg, error_type=_etype(msg), edit_index=i, used_fuzzy_path=used_fuzzy_path)
        occ = count_occurrences(base_content, edit.oldText)
        if occ > 1:
            msg = _duplicate(path, i, total, occ)
            return Result(False, base_content=base_content, error=msg, error_type=_etype(msg), edit_index=i, used_fuzzy_path=used_fuzzy_path)
        matched.append(Match(i, idx, length, edit.newText, used_fuzzy))

    matched.sort(key=lambda m: m.match_index)
    for i in range(1, len(matched)):
        prev, cur = matched[i - 1], matched[i]
        if prev.match_index + prev.match_length > cur.match_index:
            msg = f"edits[{prev.edit_index}] and edits[{cur.edit_index}] overlap in {path}. Merge them into one edit or target disjoint regions."
            return Result(False, base_content=base_content, matches=matched, error=msg, error_type=_etype(msg), edit_index=cur.edit_index, used_fuzzy_path=used_fuzzy_path)

    new_content = base_content
    for m in reversed(matched):
        new_content = new_content[:m.match_index] + m.new_text + new_content[m.match_index + m.match_length:]

    if base_content == new_content:
        msg = _no_change(path, total)
        return Result(False, base_content=base_content, new_content=new_content, matches=matched, error=msg, error_type=_etype(msg), used_fuzzy_path=used_fuzzy_path)

    return Result(True, base_content=base_content, new_content=new_content, matches=matched, used_fuzzy_path=used_fuzzy_path)


def apply(content: str, edits: list[dict], path: str) -> Result:
    return apply_edits_to_normalized_content(normalize_to_lf(content), edits, path)
