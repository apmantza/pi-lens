---
section: Changed
---
- **knip advisory job green: the last three unused test-support exports are private and the dead `scripts/hooks/**/*.ts` entry pattern is gone (closes #2708)** — `testSourceFiles`, `testsRelative` and `SCAN_INFRASTRUCTURE` in `tests/support/flake-shape-scan.ts` had no importer after #2749; the hooks are `.mjs`, so the `.ts` entry pattern matched nothing.
