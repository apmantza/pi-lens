---
section: Changed
audience: internal
---

- Twelve production sites that spelled their own whole-content sha256 of a byte buffer (partial-edit records, review-graph content fingerprints, fix-run restore, read-guard edit snapshots, observed and opaque mutation scans, the opengrep pack refresh, the archive installer integrity check and the grammar pin comparison) now call `hashContentBytes` / `hashFileBytes` in `clients/content-stamp.ts`; digests are unchanged (refs #4907).
