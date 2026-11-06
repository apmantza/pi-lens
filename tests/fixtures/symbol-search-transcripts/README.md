# symbol_search transcript fixtures

Most files are hand-written session rows. Two are not, because a hand-written
result restates what the parser expects instead of what the renderer prints:

- `real-renderer.jsonl` and `repeat-read.jsonl` carry the result text of
  `renderCompactSymbolSearch` (`clients/lens-engine.ts`, the one renderer both
  `symbol_search` surfaces call), and a `read` call with the real tool's `path`
  argument.

Regenerate after a renderer change: run `npm run build`, then a short script
that imports `renderCompactSymbolSearch` from `clients/lens-engine.js`, calls
it with `{ cwd: "/work" }` over a `SymbolSearchResult` whose hit files sit under
`/work`, and writes the text into the `toolResult` rows. The row shape is the
pi session format used by every sibling file here.
