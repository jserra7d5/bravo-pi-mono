#!/usr/bin/env python3
"""
Synthetic, deterministic demonstration that the CURRENT matcher's fuzzy path rewrites characters
OUTSIDE the intended edit span (whole-file normalization), and that the redesigned matcher does not.

This exists because the corpus replay could not MEASURE the bug's frequency: windowed reconstructions
never reproduce a fuzzy-path success (see REPORT.md). The bug is real by construction; this proves it
TRIGGERS. Zero tokens, pure code.
"""
import matcher_old as OLD
import matcher_new as NEW

# A file with UNRELATED smart quotes (line 1) and UNRELATED trailing whitespace (line 2),
# plus a target line that has a trailing space so the ASCII oldText only matches via the fuzzy path.
content = (
    'const title = “Hello”;\n'   # line 1: smart quotes — unrelated to the edit
    'const x = 1;   \n'                     # line 2: trailing whitespace — unrelated to the edit
    'function greet() {\n'
    "  return 'hi';\n"                      # line 4: TARGET (ASCII apostrophes)
    '}\n'
)
# oldText uses SMART quotes where the file has ASCII -> exact match fails -> fuzzy path triggers,
# and the OLD matcher then normalizes the WHOLE file (lines 1 and 2) as a side effect.
edits = [{"oldText": "  return ‘hi’;", "newText": "  return 'bye';"}]

old = OLD.apply(content, edits, "demo.ts")
new = NEW.apply(content, edits, "demo.ts")

def outside_span_changes(original, result_new_content):
    """Count chars changed on lines OTHER than the intended target line (line index 3)."""
    o = original.split("\n"); r = (result_new_content or "").split("\n")
    changed = []
    for i in range(max(len(o), len(r))):
        ol = o[i] if i < len(o) else "<none>"
        rl = r[i] if i < len(r) else "<none>"
        if ol != rl and i != 3:  # line index 3 == the intended target
            changed.append((i + 1, ol, rl))
    return changed

print("OLD matcher: ok=%s used_fuzzy_path=%s" % (old.ok, getattr(old, "used_fuzzy_path", "?")))
print("NEW matcher: ok=%s" % new.ok)
print()

old_outside = outside_span_changes(content, old.new_content)
print("OUTSIDE-SPAN changes by OLD matcher (the whole-file-normalization bug):")
for ln, o, r in old_outside:
    print(f"  line {ln}: {o!r}  ->  {r!r}")
print(f"  total unrelated lines mutated by OLD: {len(old_outside)}")
print()

if new.ok:
    new_outside = outside_span_changes(content, new.new_content)
    print("OUTSIDE-SPAN changes by NEW matcher (should be 0):")
    for ln, o, r in new_outside:
        print(f"  line {ln}: {o!r}  ->  {r!r}")
    print(f"  total unrelated lines mutated by NEW: {len(new_outside)}")
    verdict = "OLD bug reproduced; NEW scoped correctly" if old_outside and not new_outside else "inconclusive"
else:
    print("NEW matcher did NOT apply this fuzzy edit — it returned an error instead:")
    print(f"  {(new.error_text or '')[:200]}")
    print("  (matcher_new.normalize_with_map builds its normalized->raw map PER CHARACTER, and")
    print("   _char_fuzzy(' ')=='' strips every space, so spaced oldText never fuzzy-matches. BUG in the")
    print("   proposed fix — the map must use the same whole-string normalization as the real tool.)")
    verdict = "OLD bug reproduced; NEW fix has a fuzzy-mapping defect (errors instead of applying)"
print()
print(f"VERDICT: {verdict}.")
print(f"  OLD mutated {len(old_outside)} unrelated line(s); NEW {'applied cleanly' if new.ok else 'failed to apply (see above)'}.")
