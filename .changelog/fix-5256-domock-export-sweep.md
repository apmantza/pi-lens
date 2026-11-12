---
section: Fixed
audience: internal
---

- Read `vi.doMock` in the whole-module mock-export sweep. Only hoisted `vi.mock` skips an importer, and the flake-shape scan and the trust-seam ratchet share one registration list. (refs #5256)
