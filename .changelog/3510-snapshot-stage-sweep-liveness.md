---
section: Fixed
---

- **A second pi-lens process no longer deletes a live process's staged project snapshot (closes #3510)** — the first save in each process swept every `project-snapshot.json.gz.stage-*` file that did not carry its own pid, including one a live sibling (a pi session, or the MCP server's word-index writer) had staged but not yet promoted. The sibling's rename then failed with `ENOENT` and fell back to the synchronous main-thread gzip. The sweep now skips any stage file whose pid is alive, through the same `isStaleStageFile` predicate the review-graph sweep uses.
