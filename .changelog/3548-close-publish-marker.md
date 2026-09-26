---
section: Fixed
---

- **typos' close-triggered publish no longer answers an in-flight scan across a rename (refs #3548)** —
  typos publishes an empty, version-less diagnostic set on every
  `textDocument/didClose`, even when nothing was outstanding. pi-lens
  previously counted that publish as one of the closed lifetime's owed
  scans (the #3482 close-and-reopen carry), which could let it satisfy the
  slot a genuinely in-flight scan should satisfy: renaming a file away
  while typos was still scanning the old content let that scan's later,
  stale answer be delivered as the reopened file's fresh diagnostics. A new
  `publishesOnClose` strategy marker, set for typos, excludes exactly its
  own close-triggered publish from that count; every other server's
  close-time publish (a real, if late, backlog answer) still counts exactly
  as before. The exemption's own credit is cleared at every reopen (the
  same point the closed-path marker itself is), so a credit a close never
  got to spend cannot survive into, and stack with, a later close's own —
  which otherwise could wrongly swallow that close's first genuine backlog
  finding, permanently.
  Separately, zizmor's dynamically-registered `textDocument/didSave` (which
  re-audits and republishes, the same surplus shape as opengrep's save
  rescan) is given the existing `rescansOnSave` marker now, ahead of that
  registration being honoured — `applyDynamicCapabilities` does not yet map
  a dynamic didSave registration to anything, so this has no runtime effect
  today, but needs no further change once it does.
