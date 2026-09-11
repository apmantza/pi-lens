---
section: Fixed
---

- **vi-mock export sweep reads `importOriginal<T>()` as a pass-through** (closes #2881) — a `vi.mock` factory spreading `await importOriginal<typeof import("…")>()` no longer reports every export as dropped; the parser also recognises `as`/`satisfies` casts, parenthesised spreads, and the two-statement `const actual = await importOriginal<T>()` binding as the same complete pass-through.
