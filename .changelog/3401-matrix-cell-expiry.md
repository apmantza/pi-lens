---
section: Fixed
---

- **Stale LSP capability-matrix cells expire by date, and a tier change needs two agreeing nightly runs (#3401)** — A `direct` `first-publish` cell the nightly probe no longer observes is stamped with its first-miss date and degrades to `unknown` after five elapsed days instead of surviving forever (`empty-first` cells, which back live `emptyFirstPublish` markers, never expire), and a `clean-behavior`/`tier` change is written only after two consecutive nightly runs observe the same new value, so a single flapping run (ast-grep went 2 → 2* → 3 → 2*) cannot rewrite a cell. The bookkeeping lives in a generated section of `docs/lsp-capability-matrix.md`; each nightly now starts from the last unmerged `bot/lsp-docs-refresh` doc when it is ahead of master and still fresh, so the clock runs per nightly run, not per merged refresh. A subset probe leaves the langs it did not probe alone.
