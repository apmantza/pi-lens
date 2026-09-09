---
section: Added
---

- **Add an advisory incremental Stryker lane for changed scripts (refs #1844)** — `npm run mutation:diff` and the pull-request mutation lane use Stryker's command runner over changed `scripts/**/*.mjs` files and their related tests, report uncovered files, retain incremental results under ignored paths, and publish the mutation report for review.
