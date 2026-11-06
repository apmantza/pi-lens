---
section: Removed
audience: internal
---

- The module-level ast-grep availability sweep in `clients/dispatch/runners/utils/runner-helpers.ts` (`isSgAvailableAsync`, `getSgCommand`, the `sg` export and their helpers) is deleted: it had no production caller, carried the B1 cross-session latch write, and production ast-grep runs through `SgRunner` (closes #5345).
