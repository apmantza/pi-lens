---
section: Fixed
audience: user
---

- **`PI_LENS_DISABLE_TOOL_INSTALL=1` now stops the lazy installer and govulncheck too (#5231)** — with the switch set, `gem install rubocop`, `rustup component add clippy|rustfmt` and govulncheck's `go install` were still spawned because only the managed installer read it. Every install path now asks one shared check and answers "unavailable" without spawning; a refused install records one `install-disabled` degradation row per tool per session. `PI_LENS_DISABLE_LSP_INSTALL` is read through one shared helper as well, with no behaviour change.
