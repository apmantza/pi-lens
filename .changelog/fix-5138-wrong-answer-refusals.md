---
section: Fixed
audience: user
---

- **Unknown `severity` or `read_symbol` `kind` now fails loudly instead of returning a wrong answer (refs #5138)** — `lens_diagnostics` and `lsp_diagnostics` reject a severity outside `error`, `warning`, `information`, `hint` and `all`, naming the accepted tiers, instead of silently disabling the filter and returning every finding. `read_symbol` rejects a `kind` that matches no candidate, including on a callback handle such as `run.resetLSPService@3`, rather than falling back to a symbol of another kind. An unreadable file or a kind mismatch now answers `Could not inspect <file>: <condition>` on the pi tool and on `pilens_read_symbol`, so neither reads as `Symbol ... not found`.
