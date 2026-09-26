---
section: Fixed
---

- **The shared tools install lock no longer ages out under a legitimate ERESOLVE npm install (refs #3515)** —
  the lock's lease (the install timeout plus 60s slack, 180s by default) was
  shorter than an ERESOLVE retry, which runs two 120s install attempts inside
  one hold; nothing renewed the lock's generation while that ran, so a second
  installer could judge the first stale and start writing into the same
  managed tools directory. An unref'd heartbeat now keeps the generation's
  mtime fresh for the whole hold (the quarantine lock's async holder gets the
  same heartbeat), and `installNpmTool` re-checks that it still owns the
  lock right before its `--legacy-peer-deps` retry spawn, aborting rather
  than risk a second writer if it ever lost it anyway.
