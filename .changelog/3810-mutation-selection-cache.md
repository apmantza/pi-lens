---
section: Changed
---

- **The mutation diff runs only tests that execute a changed line, and reuses results between pushes (refs #3810)** — The advisory lane now measures, with one V8 coverage probe per import-related test file, which tests execute the PR's changed lines, keeps those ranked by covered changed lines, and never drops the PR's own test files (a new test file was previously cut by the path-ordered cap, producing false survivors). The sticky comment reports `related N → covering M → kept K`, and the truncation note appears only when a covering test was dropped. The incremental results are cached per PR and base and reused only when the kept tests and every other changed file are unchanged.
