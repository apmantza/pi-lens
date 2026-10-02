---
section: Fixed
---

- **The mutation lane's stage dispositions are pinned by a real-spawn fixture (refs #3856)** — The advisory mutation lane's own driver stages (the shared-slot wait and refusal behind a live exclusive holder, the nested-driver bypass, the budget-signal abort, an absent or partial coverage report, a compiled source with no emitted output, an unparseable source map, and a covered whitespace-only change) now run as real-spawn arms against a fake Stryker at the process boundary. Every survivor mutation on the driver's changed lines is killed or shown compile-valid equivalent, so a regression in those stages reds the lane instead of surviving silently.
