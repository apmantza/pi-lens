---
section: Changed
---

- **A PHP diagnostics hold spent by the edit fence is now logged (refs #3484)** — when the edit fence drops intelephense's empty pre-index publish, that publish counts as the one the empty-first-publish hold skips, and pi-lens now writes the same `lsp_empty_first_publish_held` record (with `via: "fence-drop"`) instead of leaving the hold looking unused. Only an empty first publish spends it; an empty publish that clears an earlier finding does not.
