---
section: Added
---

- **Add an advisory incremental Stryker lane for changed production files (refs #1844)** — `npm run mutation:diff` and the pull-request mutation lane restrict Stryker to changed TypeScript and JavaScript module sources, retain incremental results under ignored paths, and publish the mutation report for review.
