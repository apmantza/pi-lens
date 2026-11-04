---
section: Removed
audience: internal
---

- **Dead exports removed for the knip 6.44.1 bump (refs #5289)** — `summarizeWorklog` and its `WorklogStats` type (`clients/fix-worklog.ts`), `safeSpawnBatch` and the deprecated sync `isCommandAvailable` (`clients/safe-spawn.ts`) had no caller and are deleted with their sweep rows; `clients/lens-engine.ts` drops its unused re-exports of `projectModuleReport`, `renderCompactModuleReport` and four `ModuleReport*` types, which tests import from `clients/module-report.ts` directly. `resetUtf8ConsoleCodePageStateForTests` stays as the review-kept test seam (#1201), marked `@public`.
