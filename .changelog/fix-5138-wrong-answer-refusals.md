---
section: Fixed
audience: user
---

- **Unknown `severity` or `read_symbol` `kind` now fails loudly instead of returning a wrong answer (refs #5138)** — `lens_diagnostics` and `lsp_diagnostics` reject a severity outside `error`, `warning`, `information`, `hint` and `all`, naming the accepted tiers, instead of silently disabling the filter and returning every finding. `read_symbol` rejects a `kind` that matches no candidate rather than falling back to a symbol of another kind. An unreadable file now answers `Could not inspect <file>: <condition>`, so it is distinguishable from `Symbol ... not found`.
