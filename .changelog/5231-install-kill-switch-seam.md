---
section: Fixed
audience: user
---

- **`PI_LENS_DISABLE_TOOL_INSTALL=1` now also stops the lazy installer and govulncheck (refs #5231)** — with the switch set, `gem install rubocop`, `rustup component add clippy|rustfmt` and `go install …/govulncheck` were still spawned, because only the managed installer read it. Both now answer "unavailable" without spawning an installer, a tool already on disk is still found, and unsetting the switch lets the next call install. The switch and `PI_LENS_DISABLE_LSP_INSTALL` each have one reader in `clients/env-utils.ts`, and a sweep fails a new install path that reads either itself.
