---
section: Fixed
---

- **Project-snapshot persistence validates gzip body integrity before skipping (closes #2008)** —
  The skip decision trusted the meta sidecar and a fingerprint match alone, so a torn or
  truncated gzip under an intact meta kept winning unchanged-dedupe and stayed canonical until
  the project sequence advanced. The meta sidecar now records the on-disk gz byte length
  (`gzBytes`) at every successful persist, and the dedupe baselines compare it against a live
  stat: a size mismatch, or a legacy meta without the field, withholds the dedupe fingerprints
  so the pending save republishes and rewrites the body. A skip that would honor evidence
  failing this gate between dispatch and promotion is refused and rewritten synchronously.
  Detections emit one `project_snapshot_body_integrity` latency record plus a bounded
  `snapshot-integrity` degradation-ledger entry per corrupted body path. The baselines read is
  also now a pure read: its in-process seeding write moved to the single dispatch seam that
  owns the persist lifecycle.
