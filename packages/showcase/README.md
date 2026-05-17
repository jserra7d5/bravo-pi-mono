# @bravo/showcase

Pi extension package that registers a `showcase` tool. The tool renders a requested file or line slice inline in the Pi TUI for the user while returning only a short status message to the model.

## Tool

`showcase` parameters:

- `path` — file to render; relative paths resolve from the current Pi session cwd.
- `offset` — 1-indexed starting line; defaults to `1`.
- `limit` — max lines to render; defaults to `200`, capped at `1000`.
- `title` — optional title shown above the rendered content.
- `mode` — `auto`, `markdown`, `code`, `json`, `diff`, or `plain`.
- `language` — optional language hint for code highlighting.

The extension adds a concise prompt guideline so agents use `showcase` only on user request, or after prompting when discussing specific edits, code sections, prompt sections, plans, or designs.

## Install/use in Pi

Install this workspace/package alongside `@earendil-works/pi-coding-agent` and enable Pi packages/extensions through Pi's package mechanism. This package advertises its Pi extension in `package.json`:

```json
{
  "pi": {
    "extensions": ["./extensions/pi"]
  }
}
```

Example request:

> Showcase `packages/foo/src/index.ts` lines 40-90.
