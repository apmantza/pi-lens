---
section: Fixed
---

- **mode=full no longer replays stale mid-edit blockers (refs #1993)** — a confirmed, fully-covered LSP sweep is now authoritative for its files: widget-store diagnostics captured from a since-fixed broken intermediate state are retired instead of rendering as current 🔴 blockers beside a clean sweep. Unconfirmed or timed-out sweeps keep the fail-open behavior.
