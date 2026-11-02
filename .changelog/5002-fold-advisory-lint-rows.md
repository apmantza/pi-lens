---
section: Changed
audience: internal
---

- A pull request posts fewer CI check rows with the same coverage: vale, jscpd, complexity, strictness, yamllint, typos and taplo are steps of one `Lint (advisory)` job, `PR title` and `Close-keyword syntax` are steps of one gating `PR metadata` job, and OSV scan starts from a `paths:` filter instead of a detect job. Required check names are unchanged. (refs #5002)
