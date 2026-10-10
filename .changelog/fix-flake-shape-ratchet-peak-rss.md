---
section: Fixed
audience: internal
---

- Flake-shape ratchet: yield the event loop between files so `@ast-grep/napi` releases each parsed tree's native memory, cutting the test file's peak RSS from ~2,049 MB (over the 2,048 MB per-worker budget) to ~313 MB (refs #4292).
