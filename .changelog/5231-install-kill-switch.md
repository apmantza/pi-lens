---
section: Fixed
audience: user
---

- **`PI_LENS_DISABLE_TOOL_INSTALL=1` now stops the lazy installer, govulncheck and `npx` downloads too (#5231)** — with the switch set, `gem install rubocop`, `rustup component add clippy|rustfmt`, govulncheck's `go install` and the `npx @biomejs/biome` probe were still spawned or still downloaded, because only the managed installer read it. The first three now answer "unavailable" without spawning and record one `install-disabled` degradation row per tool per session; `npx` runs offline (`npm_config_offline=true`), so it uses npm's cache or fails. `PI_LENS_DISABLE_LSP_INSTALL` is read through one shared helper as well, with no behaviour change.
