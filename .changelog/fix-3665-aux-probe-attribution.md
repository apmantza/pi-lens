---
section: Fixed
audience: internal
---

- **The nightly clean-signal probe scores an auxiliary fixture on the auxiliary's own publishes (refs #3665)** — `scripts/probe-clean-signal.mjs` picked the file's primary server for the ast-grep, opengrep, zizmor, typos and ast-grep-baseline rows, so each read typescript's, yaml's or marksman's publishes and the ast-grep cell flapped between versioned, unversioned and silent. The row's server id now comes from the fixture's declared `auxiliaryServerIds`, and a non-auxiliary fixture still resolves its primary.
