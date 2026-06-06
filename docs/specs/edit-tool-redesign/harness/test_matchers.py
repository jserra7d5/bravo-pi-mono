#!/usr/bin/env python3
"""Deterministic unit suite for old/new edit matcher behavior.

Run with: python3 test_matchers.py
Uses stdlib unittest only; no filesystem/network fixtures.
"""
from __future__ import annotations

import json
import unittest

import matcher_old
import matcher_new


PATH = "sample.txt"


def edit(old: str, new: str) -> dict:
    return {"oldText": old, "newText": new}


class MatcherBehaviorTests(unittest.TestCase):
    def assert_new_error(self, result: matcher_new.Result, code: str) -> dict:
        self.assertFalse(result.ok)
        self.assertIsInstance(result.error, dict)
        self.assertEqual(result.error.get("code"), code)
        # Ensure the machine-readable envelope is also exposed as JSON text.
        self.assertEqual(json.loads(result.error_text), result.error)
        return result.error

    def assert_old_error(self, result: matcher_old.Result, code: str, text_fragment: str) -> None:
        self.assertFalse(result.ok)
        self.assertEqual(result.error_type, code)
        self.assertIsInstance(result.error, str)
        self.assertIn(text_fragment, result.error)

    def test_01_exact_single_edit_parity(self):
        content = "alpha\nbeta\ngamma\n"
        edits = [edit("beta\n", "BETA\n")]

        old = matcher_old.apply(content, edits, PATH)
        new = matcher_new.apply(content, edits, PATH)

        self.assertTrue(old.ok)
        self.assertTrue(new.ok)
        self.assertEqual(new.new_content, "alpha\nBETA\ngamma\n")
        self.assertEqual(new.new_content, old.new_content)
        self.assertEqual(new.matches[0].match_kind, "exact")

    def test_02_multi_edit_disjoint_original_snapshot_reverse_offsets(self):
        content = "aaa\nbbb\nccc\nddd\n"
        # Edits are intentionally supplied in reverse file order; both must be located
        # against the original snapshot and then applied from high offset to low offset.
        edits = [edit("ccc\n", "CCC\n"), edit("aaa\n", "AAA\n")]

        old = matcher_old.apply(content, edits, PATH)
        new = matcher_new.apply(content, edits, PATH)

        self.assertTrue(old.ok)
        self.assertTrue(new.ok)
        self.assertEqual(new.new_content, "AAA\nbbb\nCCC\nddd\n")
        self.assertEqual(new.new_content, old.new_content)
        self.assertEqual([m.edit_index for m in new.matches], [1, 0])

    def test_03_overlap_error(self):
        content = "abcde\n"
        edits = [edit("abc", "X"), edit("bcd", "Y")]

        old = matcher_old.apply(content, edits, PATH)
        new = matcher_new.apply(content, edits, PATH)

        env = self.assert_new_error(new, "overlap")
        self.assertEqual(env["suggested_action"], "merge_or_disjoint")
        self.assert_old_error(old, "overlap", "overlap")

    def test_04_not_found_structured_recovery_and_old_string(self):
        content = "alpha\nbeta\ngamma\n"
        edits = [edit("delta\n", "DELTA\n")]

        old = matcher_old.apply(content, edits, PATH)
        new = matcher_new.apply(content, edits, PATH)

        env = self.assert_new_error(new, "not_found")
        self.assertEqual(env["suggested_action"], "read_range_and_retry")
        self.assertIn("recovery", env)
        self.assertTrue(env["recovery"].get("near_misses") is not None or env["recovery"].get("read_range") is not None)
        self.assert_old_error(old, "not_found", "Could not find")

    def test_05_not_unique_occurrence_envelope_and_old_duplicate_string(self):
        content = "alpha\nsame\nbeta\nsame\nomega\n"
        edits = [edit("same\n", "unique\n")]

        old = matcher_old.apply(content, edits, PATH)
        new = matcher_new.apply(content, edits, PATH)

        env = self.assert_new_error(new, "not_unique")
        self.assertGreaterEqual(env["occurrence_count"], 2)
        self.assertGreaterEqual(len(env["occurrences"]), 2)
        for occ in env["occurrences"][:2]:
            self.assertIn("line_start", occ)
            self.assertIn("line_end", occ)
            self.assertIn("occurrence", occ)
        self.assert_old_error(old, "not_unique", "Found 2 occurrences")

    def test_06_no_op_error(self):
        content = "alpha\nbeta\n"
        edits = [edit("beta\n", "beta\n")]

        old = matcher_old.apply(content, edits, PATH)
        new = matcher_new.apply(content, edits, PATH)

        env = self.assert_new_error(new, "no_change")
        self.assertEqual(env["suggested_action"], "skip_or_change_replacement")
        self.assert_old_error(old, "no_change", "No changes made")

    def test_07_empty_old_text_error(self):
        content = "alpha\n"
        edits = [edit("", "prefix")]

        old = matcher_old.apply(content, edits, PATH)
        new = matcher_new.apply(content, edits, PATH)

        env = self.assert_new_error(new, "empty")
        self.assertEqual(env["suggested_action"], "provide_non_empty_oldText")
        self.assert_old_error(old, "empty", "oldText must not be empty")

    def test_08_fuzzy_unicode_and_trailing_whitespace_new_matches_and_applies(self):
        content = "quote “Hello” – em — space\u00a0end   \nnext\n"
        edits = [edit('quote "Hello" - em - space end\n', "REPLACED\n")]

        new = matcher_new.apply(content, edits, PATH)

        self.assertTrue(new.ok, new.error_text)
        self.assertEqual(new.new_content, "REPLACED\nnext\n")
        self.assertEqual(new.matches[0].match_kind, "fuzzy")

    def test_09_scoped_fuzzy_preserves_unrelated_text_and_old_normalizes_whole_file(self):
        content = "KEEP “curly”   \nTarget: “A” – B   \nKEEP\u00a0NBSP\n"
        edits = [edit('Target: "A" - B\n', "Target: X\n")]
        expected_new = "KEEP “curly”   \nTarget: X\nKEEP\u00a0NBSP\n"

        new = matcher_new.apply(content, edits, PATH)
        old = matcher_old.apply(content, edits, PATH)

        self.assertTrue(new.ok, new.error_text)
        self.assertEqual(new.new_content, expected_new)
        self.assertEqual(new.matches[0].match_kind, "fuzzy")
        self.assertTrue(old.ok, old.error)
        # Documented contrast: old applies replacements to the whole-file normalized base,
        # mutating unrelated smart quotes, NBSPs, and trailing spaces outside the target span.
        self.assertNotEqual(old.new_content, expected_new)
        self.assertIn('KEEP "curly"\n', old.new_content)
        self.assertIn("KEEP NBSP\n", old.new_content)

    def test_10_crlf_input_is_normalized_to_lf_at_matcher_level(self):
        content = "alpha\r\nbeta\r\ngamma\r\n"
        edits = [edit("beta\n", "BETA\n")]

        old = matcher_old.apply(content, edits, PATH)
        new = matcher_new.apply(content, edits, PATH)

        self.assertTrue(old.ok)
        self.assertTrue(new.ok, new.error_text)
        # matcher_new operates in LF-normalized space; CRLF restoration is a higher tool layer concern.
        self.assertEqual(new.new_content, "alpha\nBETA\ngamma\n")
        self.assertEqual(old.new_content, new.new_content)

    def test_11_bom_leading_file_old_text_without_bom_matches(self):
        content = "\ufeffHeader\nbody\n"
        edits = [edit("Header\n", "Title\n")]

        old = matcher_old.apply(content, edits, PATH)
        new = matcher_new.apply(content, edits, PATH)

        self.assertTrue(old.ok)
        self.assertTrue(new.ok, new.error_text)
        self.assertEqual(new.new_content, "\ufeffTitle\nbody\n")
        self.assertEqual(old.new_content, new.new_content)

    def test_12_leading_and_interior_whitespace_preserved_through_fuzzy_mapping(self):
        content = "def f():\n    return “hi”   \n"
        edits = [edit('    return "hi"\n', '    return "bye"\n')]

        new = matcher_new.apply(content, edits, PATH)

        self.assertTrue(new.ok, new.error_text)
        self.assertEqual(new.matches[0].match_kind, "fuzzy")
        self.assertEqual(new.new_content, 'def f():\n    return "bye"\n')


if __name__ == "__main__":
    unittest.main(verbosity=2)
