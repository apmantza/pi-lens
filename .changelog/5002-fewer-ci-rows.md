---
section: Changed
audience: internal
---

- A pushed pull request posts four fewer CI check rows with the same coverage: the skipped `Classify failed Unit tests` and `Finalize CI rerun classification` rows are gone, `actionlint` and `markdownlint` are steps of one gating `actionlint & markdownlint` job, and the boundary check moved into the required `Lint & type-check`. Required check names are unchanged. (refs #5002)
