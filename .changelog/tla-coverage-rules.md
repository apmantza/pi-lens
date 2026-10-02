---
section: Added
audience: internal
---

- `formal/coverage-map.json` maps runtime source globs to TLA+ model families,
  and `scripts/lib/tla-coverage.mjs` (wired into the PR-body lint, which now
  also runs on `synchronize`) flags a PR that changes a mapped file without
  moving any one of the row's families' models or declaring
  `TLA+ unaffected: <family> — <reason>`; rows of 4+ families and `unmodelled`
  seams stay advisory, and `validateCoverageMap` reds when a `formal/<dir>` is
  missing from the map (refs #3802).
