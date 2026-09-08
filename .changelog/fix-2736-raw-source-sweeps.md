---
section: Fixed
---

- **Test ratchets now ignore comment and string laundering when matching source requirements (closes #2736)** — the Git-fixture, NDJSON writer, runner outcome, flake-shape, and LSP double-admission header detectors now use `stripSource`-based evidence, preserving string literals only where they carry the command or import path being checked.
