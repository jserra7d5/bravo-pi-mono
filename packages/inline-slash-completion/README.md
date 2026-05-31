# @bravo/inline-slash-completion

Pi extension for inline slash completion and multi-skill expansion.

## Behavior

- Press `Tab` after an inline slash token such as ` /skill:cont` or ` /mod` to get the normal slash-command suggestions while preserving the token's inline position.
- Inline slash tokens are completed before forced path completion so bare ` /` opens command suggestions instead of root-path suggestions. Other contexts delegate to Pi's native `@` file and path completion.
- Native Pi currently auto-triggers slash completion only at the start of the message, so inline slash completion is Tab-triggered.
- Multiple inline `/skill:name` directives can be used anywhere in a request. The extension expands each unique discovered skill into a `<skill ...>` block, removes the directive tokens, and leaves the remaining text as the actual request.

## Limitations

- Inline skill arguments are not supported. Use Pi's native leading `/skill:name args` form when passing arguments to one skill.
- Unknown skills, URLs, and other slash/path-looking tokens are not transformed; only `/skill:<name>` commands discovered from `pi.getCommands()` are expanded.

## Development

```bash
npm run check --workspace @bravo/inline-slash-completion
```
