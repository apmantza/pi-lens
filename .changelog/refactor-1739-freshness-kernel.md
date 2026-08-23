---
section: Added
---

- **Freshness kernel: one comparator, one verdict type for staleness gates (closes #1739)** — `clients/freshness.ts` owns the mtime-vs-reference comparison and shared drift tolerance that six stores had independently reimplemented (three copies carried the identical #1710/#1711 tolerance defect). `freshnessFromMtime` returns an explicit verdict (`fresh` / `stale: modified-after-reference` / `indeterminate: no-mtime-evidence`) so each caller keeps its own no-evidence policy while sharing the comparison. A registered-or-fail sweep fails on any new out-of-kernel mtime-vs-reference comparison in `clients/`.
