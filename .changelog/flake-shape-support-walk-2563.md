---
section: Fixed
---

- **Flake-shape ratchet governs support-helper waits (refs #2563, #2784)** — the contention ratchet scans `.ts` and `.mts` support helpers, resolves aliased timers, and requires every support baseline row to carry a detector-specific reason, header, and serialized-lane proof through its importing tests; **Reduce flake-shape ratchet AST scanning cost (refs #2563, #2784)** — the whole-tree scan uses a comment/string-blanked textual pre-pass and parses each timer-bearing source file at most once per run.
