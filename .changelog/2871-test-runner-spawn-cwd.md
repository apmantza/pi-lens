---
section: Fixed
---

- **The test runner spawns its child through `resolveToolCwd`, so a nested module's tests run from that module (refs #2871)** — a `.go` file in a nested `go.mod` module now runs `go test ./internal/…` from the module that owns the package instead of a root-relative path the root module cannot resolve, with the shared seam supplying marker discovery, the `.git`/dispatch-root fallbacks, the `$HOME` ceiling and one `tool-cwd` log line per resolution key; a whole-project build launches from the directory that owns its wrapper (`gradle`, `maven`), a child is never anchored on a config file the detector itself rejected as evidence (`pytest`'s `pyproject.toml`, `phpunit`'s `composer.json`), and the failed-target ledger stays keyed on the dispatch root.
