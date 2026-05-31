# @bravo/tui-enhancements

Pi extension for terminal UI quality-of-life features.

## Behavior

### Inline slash completion and multi-skill expansion

- Press `Tab` after an inline slash token such as ` /skill:cont` or ` /mod` to get the normal slash-command suggestions while preserving the token's inline position.
- Inline slash tokens are completed before forced path completion so bare ` /` opens command suggestions instead of root-path suggestions. Other contexts delegate to Pi's native `@` file and path completion.
- Native Pi currently auto-triggers slash completion only at the start of the message, so inline slash completion is Tab-triggered.
- Multiple inline `/skill:name` directives can be used anywhere in a request. The extension expands each unique discovered skill into a `<skill ...>` block, removes the directive tokens, and leaves the remaining text as the actual request.

### Link helpers

- `/links` scans the current session branch for links and opens an overlay selector. Press `Enter` or `y` to copy the selected target via OSC52; press `Esc` to cancel. The selected row also gets a short OSC8 clickable preview line when the terminal supports hyperlinks.
- `/copy-link` copies the most recent link from the same ordering as `/links`.
- `/copy-link 3` copies the third recent link.
- `/copy-link auth.ts` copies the first link whose label or target contains `auth.ts`.

Detected links include:

- `http://` and `https://` URLs.
- Markdown links like `[label](https://example.com/path)`.
- Absolute file paths such as `/home/me/project/src/app.ts`, including `/path/file.ts:42` and `/path/file.ts:42:5` suffixes. File targets are copied as encoded `file://` URLs; labels are workspace-relative when possible.

Targets are deduplicated by copied target, with the newest occurrence shown first.

## Terminal clipboard and hyperlink notes

The extension copies links with OSC52. In plain terminals it writes a normal OSC52 sequence. Inside tmux it wraps OSC52 for tmux passthrough.

Recommended tmux settings:

```tmux
set -g set-clipboard on
set -g allow-passthrough on
set -ga terminal-features "*:clipboard:hyperlinks"
```

Terminal support varies. Some terminals require enabling clipboard access or hyperlink support in preferences. Normal assistant messages are not modified; OSC8 is limited to a short non-wrapping preview line in the `/links` overlay to avoid corrupting wrapped markdown output.

## Limitations

- Inline skill arguments are not supported. Use Pi's native leading `/skill:name args` form when passing arguments to one skill.
- Unknown skills, URLs, and other slash/path-looking tokens are not transformed; only `/skill:<name>` commands discovered from `pi.getCommands()` are expanded.
- Link extraction is text-based and intentionally conservative; unusual quoting, relative paths, or wrapped links may not be detected.
- OSC52 copies are skipped for very large payloads (>100k characters).

## Install

```bash
pi install /home/joe/Documents/projects/bravo-pi-mono/packages/tui-enhancements
```

## Development

```bash
npm run check --workspace @bravo/tui-enhancements
```
