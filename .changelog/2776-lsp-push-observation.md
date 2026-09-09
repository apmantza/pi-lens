---
section: Fixed
---

- **Keep pull capability until unavailable and reconcile late pushes (refs #2776)** — Treat `publishDiagnostics` as observed-channel telemetry, keep pull capability for both-channel servers, demote only after a pull is proven unavailable, and let a diagnostic push supersede a provisional empty pull.
