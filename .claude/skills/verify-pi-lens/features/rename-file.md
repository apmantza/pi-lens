# rename_file

`pilens_lsp_navigation {operation: "rename_file"}` moves a file and tells the
language servers. Scenario: `scripts/scenarios/rename-file.mjs`, server Pyrefly.

## Sub-features

- Move on disk with `apply: true`; preview without.
- `workspace/willRenameFiles` edits from servers that advertise it, and
  `didRenameFiles` for servers that advertise that.
- File events for servers that advertise neither (Pyrefly advertises
  `willRename` only): old path Deleted (3), new path Created (1), so the server
  forgets the old module and resolves the new one (#4344 r1 F2).

## How to get to it (user POV)

An agent renames `old_module.py` to the name an importer already uses, then
checks the importer and asks where `describe_source` is defined.

## Driving it with the pi-lens MCP server

`scripts/verify.mjs drive rename-file`, variant `into-missing-path`.

- **Goal, `into-missing-path`: move a module into the path an importer was missing, then re-check the
  importer and jump to the definition.**
  - Diagnostics: before the move, `probe.py` reports `missing-import`; after,
    a check of `[new_module.py, probe.py, bad.py]` has none for `probe.py` and
    still has it for `bad.py`.
  - Definition JSON: `pilens_lsp_navigation {operation: "definition", view: "json"}` from
    `probe.py` returns exactly one result whose `uri` ends in
    `/src/fixturepkg/new_module.py`, not the import site in `probe.py`.
  - Wire (`lsp-wire.in`): `didChangeWatchedFiles` with `old.py` `"type":3` and
    `new_module.py` `"type":1`.
  - File state: `new_module.py` exists and `old.py` does not.

Evidence in `$EVIDENCE/rename-file-into-missing-path-<stamp>-<pid>/`, same layout as
`lsp-diagnostics.md`.

## Gotchas

- The rename result is a JSON line followed by prose; `verify.mjs` parses the
  first JSON-object line as `out.json`.
- A server that does implement `didRenameFiles` should receive that instead of
  the synthetic events; this recipe only covers the Pyrefly shape.
- A rename keeps the file's birth time, so without the synthetic Created the
  first open is announced Changed and the stale lookup survives.
