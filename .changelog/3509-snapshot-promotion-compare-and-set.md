---
section: Fixed
---

- **A sibling process's older project snapshot no longer replaces a newer one (closes #3509)** — a pi session and the MCP server's word-index writer (or two sessions in one checkout) share one snapshot cache. A slow writer holding an older view could rename its body over a sibling's newer one, and its admission could write an older meta seq over the newer body, so the next session threw a fresh snapshot away. Every writer now takes a cache-dir lock (`project-snapshot.json.gz.locks`, the generation lock from #3476). Under it, a body lands only while the durable meta is not ahead of its own seq, and the admission meta write only ever raises the seq. A refused body is dropped with a `superseded_on_disk` decision row in `latency.log`. When the lock stays held past its 500 ms wait, the save is dropped as a failed persist and `project-snapshot-lock-unavailable` is recorded in the degradation ledger.
