# ANSI and width math reference

Terminal display widths are not string lengths. Every helper that measures, pads, or truncates content in a TUI must understand ANSI escape sequences AND multi-cell characters (emoji, CJK). Get this wrong and chrome misaligns; get it really wrong and a stray escape sequence colors the rest of the user's terminal session red.

## The minimum viable helpers

```ts
// Strip ANSI escape codes. Use this before measuring or comparing strings visually.
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

// Cell width — approximate. Sufficient for ASCII-heavy content.
const visWidth = (s: string): number => stripAnsi(s).length;
```

These two work for ASCII text with ANSI escapes — they cover ~80% of the cases in this repo. Use them in tests and simple cards.

## The full visWidth (handles emoji, CJK, combining chars)

When your card content includes user-supplied strings, file paths in arbitrary languages, or emoji (state glyphs in some terminals), you need the proper version:

```ts
function visWidth(s: string): number {
  // Strip ANSI escapes first.
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  let width = 0;
  // Iterate by code point (NOT by index — surrogate pairs).
  for (const ch of plain) {
    const cp = ch.codePointAt(0)!;
    // Zero-width joiner — connects emoji sequences
    if (cp === 0x200D) continue;
    // Variation selectors — affect prior character, take 0 cells themselves
    if (cp >= 0xFE00 && cp <= 0xFE0F) continue;
    // CJK Unified Ideographs and similar — 2 cells
    if (
      (cp >= 0x1100 && cp <= 0x115F) ||  // Hangul Jamo
      (cp >= 0x2E80 && cp <= 0x303E) ||  // CJK Radicals + punctuation
      (cp >= 0x3041 && cp <= 0x33FF) ||  // Hiragana, Katakana, CJK
      (cp >= 0x3400 && cp <= 0x4DBF) ||  // CJK Extension A
      (cp >= 0x4E00 && cp <= 0x9FFF) ||  // CJK Unified Ideographs
      (cp >= 0xA000 && cp <= 0xA4CF) ||  // Yi
      (cp >= 0xAC00 && cp <= 0xD7A3) ||  // Hangul Syllables
      (cp >= 0xF900 && cp <= 0xFAFF) ||  // CJK Compatibility
      (cp >= 0xFE30 && cp <= 0xFE4F) ||  // CJK Compatibility Forms
      (cp >= 0xFF00 && cp <= 0xFF60) ||  // Fullwidth
      (cp >= 0xFFE0 && cp <= 0xFFE6)     // Fullwidth signs
    ) {
      width += 2;
      continue;
    }
    // Emoji ranges (approximation — full coverage requires emoji-width table)
    if (
      (cp >= 0x1F300 && cp <= 0x1F9FF) ||  // misc symbols, pictographs
      (cp >= 0x2600 && cp <= 0x27BF) ||    // misc + dingbats
      (cp >= 0x1FA70 && cp <= 0x1FAFF)     // symbols extended-A
    ) {
      width += 2;
      continue;
    }
    width += 1;
  }
  return width;
}
```

Implementations of this exist in `packages/async-subagents/extensions/pi/renderers.ts` and `packages/bravo-goals/extensions/pi/renderers.ts`. They are tested for known collision cases (names that hash to the same identity slot, emoji-bearing summaries, CJK display names).

## Truncation — preserving ANSI

Naive truncation breaks ANSI. `"foo\x1b[31mbar\x1b[0m".slice(0, 7)` returns `"foo\x1b["` — a half-cut escape sequence that colors the rest of your terminal output.

```ts
function truncAnsi(str: string, maxCells: number): string {
  if (maxCells <= 0) return "";
  let out = "";
  let cells = 0;
  let i = 0;
  const ELLIPSIS = "…";

  while (i < str.length) {
    const ch = str[i];
    // Pass through ANSI escape sequences without counting cells.
    if (ch === "\x1b" && str[i + 1] === "[") {
      const end = str.indexOf("m", i);
      if (end !== -1) {
        out += str.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    // Compute the cell width of this character (codepoint).
    const cp = str.codePointAt(i)!;
    const charLen = cp > 0xFFFF ? 2 : 1;   // UTF-16 surrogate pair?
    let cellWidth = 1;
    // Apply the same rules as visWidth for 0-cell and 2-cell characters
    if (cp === 0x200D || (cp >= 0xFE00 && cp <= 0xFE0F)) cellWidth = 0;
    else if (isDoubleCell(cp)) cellWidth = 2;

    if (cells + cellWidth > maxCells - 1) {
      // Need to truncate. Append ellipsis (1 cell) and any closing reset.
      out += ELLIPSIS;
      if (str.includes("\x1b[0m", i)) out += "\x1b[0m";
      return out;
    }
    out += str.slice(i, i + charLen);
    cells += cellWidth;
    i += charLen;
  }
  return out;
}
```

(Where `isDoubleCell` covers the same CJK + emoji ranges as `visWidth`.)

## Mid-truncation for paths

File paths and slugs are better mid-truncated — preserves the meaningful head (directory hint) and tail (filename hint).

```ts
function truncMid(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}
```

Use cases:
- File paths in card titles: `/home/joe/...projects/bravo-pi-mono/packages/showcase/extensions/pi/index.ts` → `/home/joe/...sions/pi/index.ts`
- Goal slugs in footer rows: `2026-q2-bravo-judge-runner-with-isolated-receipt-verdict-flow` → `2026-q2-bra…verdict-flow`

Note: `truncMid` works on plain strings. If the string contains ANSI escapes, strip them, truncate, re-apply. For most use cases (paths/slugs) escapes aren't embedded.

## End-truncation for summaries

```ts
function truncEnd(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}
```

Use cases:
- Summary text in result cards
- Long error messages
- Anything where the start is most important

## Padding rows to width

Container chrome puts a side bar on the right of every row. The content needs to be padded to a fixed inner width so the side bar lines up.

```ts
function padRow(content: string, innerWidth: number): string {
  const cells = visWidth(content);
  const pad = Math.max(0, innerWidth - cells);
  return content + " ".repeat(pad);
}
```

`innerWidth = totalWidth - 4` (for `▌ ` left + ` │` right). If your content already exceeds `innerWidth`, you've failed to truncate upstream — add it as a test case.

## Common width-math bugs

1. **Counting ANSI as content.** `"\x1b[31mfoo\x1b[0m".length === 12` but the visible content is 3 cells. Always go through `visWidth`.

2. **Math.floor on bar fill.** `Math.floor((4.7 / 100) * 16) === 0` for a 4.7% context fill — bar appears empty. Use `Math.round` so 4.7% renders as 1 cell, not 0. Test with `0.5%`, `1%`, `4.7%` boundaries.

3. **Forgetting trailing ANSI reset.** A truncated string like `"foo\x1b[31mba"` (cut mid-color) bleeds the color into the next row. Always append `\x1b[0m` (reset) on truncation if there's an open color.

4. **CJK in a fixed-width column.** A title with `日本語` is 6 cells, not 3. If you allocate 3 cells of column width, the next column shifts. Test with at least one CJK fixture if your card accepts user-supplied strings.

5. **ZWJ emoji sequences as multi-cell.** `👨‍👩‍👧‍👦` is one visible glyph but contains 4 emoji + 3 ZWJ codepoints. Naive iteration sees 7 things. Use `for (const ch of str)` (iterates by code point, handles surrogate pairs) and treat ZWJ as 0 cells.

6. **Variation selectors counted.** `❤️` is `U+2764 U+FE0F` — heart + emoji-presentation variant selector. Two code points, one visible cell. Variation selectors must count as 0.

7. **Hard-coded width.** `const width = 80;` is always wrong. Width comes from pi's `render(width)`. The hardcoded 80 in pi's old `showcase` tool is why its chrome wrapped everywhere except the dev's terminal.

## Testing patterns

For every renderer that does width math, write tests that:

```ts
// 1. Chrome holds declared width
for (const w of [44, 56, 72, 96, 120]) {
  const lines = renderCard({ width: w, /* ... */ });
  for (const line of lines) {
    assert.equal(visWidth(line), w, `line at width ${w} should be ${w} cells`);
  }
}

// 2. Mid-truncation at boundary
assert.equal(truncMid("abcdefghij", 5), "ab…ij");

// 3. ANSI preserved through truncation
const colored = `${ANSI.warn}long warning text here${ANSI.reset}`;
const truncated = truncAnsi(colored, 10);
assert.ok(truncated.includes(ANSI.warn));
assert.ok(truncated.endsWith(ANSI.reset));

// 4. Emoji counted as 2 cells
assert.equal(visWidth("hi 🎉"), 5);  // h(1) + i(1) + space(1) + 🎉(2)

// 5. ZWJ family counted as 2 cells (one visible emoji)
assert.equal(visWidth("👨‍👩‍👧‍👦"), 2);
```

The async-subagents and bravo-goals test files have extensive examples.
