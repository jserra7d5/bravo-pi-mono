# @bravo/context-maps

Pi extension providing `context_map_create` and `context_map_read`.

Context maps are orientation artifacts: they route agents to likely load-bearing files and line ranges, then exact source is materialized selectively with `context_map_read`.

Artifacts are stored under `.pi/state/context-maps/<map_id>.json` so parent and child Pi processes in the same workspace can resolve them by `map_id`.

## Tools

- `context_map_create({ query, roots?, max_slices?, seed?, exclude? })`: runs Source Search, stores handles/previews, returns an orientation brief.
- `context_map_read({ map_id, slice_ids })`: returns exact text for selected slices with path and line metadata, enforcing output caps.

Use direct `read`/`grep` for named files and `ranked_search` for narrow lexical lookups. Do not treat create output as evidence. Map reads resolve from the workspace git root and re-check Source Search-equivalent safety policy before materializing source.

## Async subagent handoff

Async subagents launch child Pi with project extension auto-discovery disabled, so context-map tools must be forwarded explicitly via async-subagents `defaultExtensions`:

```json
{
  "defaultExtensions": [
    {
      "path": "/absolute/path/to/bravo-pi-mono/packages/context-maps/dist/extensions/pi/index.js",
      "approved": true,
      "tools": ["context_map_create", "context_map_read"]
    }
  ]
}
```

Recommended scout flow:

1. Parent starts a scout for broad or ambiguous code/docs discovery.
2. Scout calls `context_map_create` and returns `context_map:<map_id>` plus the suggested read order.
3. Scout may call `context_map_read` for a few load-bearing slices needed to make exact handoff claims.
4. Parent calls `context_map_read` on selected slices before synthesizing or citing exact behavior.
5. Downstream task receipts may reference `context_map:<map_id>` instead of embedding large source excerpts.

Do not use context maps for named-file inspection; use direct `read`/`grep` instead.
