---
section: Added
audience: internal
---

- **CI flags the tests that already spent most of their timeout.** `scripts/check-test-timeout-headroom.mjs` reads each shard's `vitest-results.json`, folds the effective per-test budget out of the source (the `it`/`test` value, the enclosing `describe`, `vi.setConfig`, `scaledTestTimeout`, or Vitest's default), and annotates every assertion that ran past 60% of it. The step is advisory and `scripts/test-timeout-headroom-baseline.json` carries the current offenders, so the annotation surface is the new ones. (`--fail-on-new` makes the same check block.) A baseline row whose test has been renamed or deleted is printed as `stale` so the ledger cannot quietly stop measuring. (refs #5311)
