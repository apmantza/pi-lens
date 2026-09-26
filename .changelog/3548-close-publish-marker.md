---
section: Fixed
---

- **typos' close-triggered publish no longer answers an in-flight scan, and can no longer overwrite a real answer after a reopen (refs #3548)** —
  typos publishes an empty, version-less diagnostic set on every
  `textDocument/didClose`, even when nothing was outstanding, and — verified
  against tekumara/typos-lsp's upstream source — this is the ONLY
  version-less publish it ever sends: every real scan answer, a genuinely
  clean one included, carries a version. pi-lens previously counted the
  close-triggered publish as one of the closed lifetime's owed scans (the
  #3482 close-and-reopen carry), which could let it satisfy the slot a
  genuinely in-flight scan should satisfy: renaming a file away while typos
  was still scanning the old content let that scan's later, stale answer be
  delivered as the reopened file's fresh diagnostics. A first fix (a
  per-close skip credit) closed that path but, an adversarial review round
  found, left the credit's underlying publish free to land on the OPEN path
  after a reopen instead — there it fell through to the ordinary handler,
  which stores the latest publish unconditionally and counts it toward the
  backlog, so it could overwrite an already-stored genuine finding and
  report a false clean. The shipped fix is stateless: a version-less
  publish from a server marked `publishesOnClose` (typos) is now dropped
  before it can be stored or counted, in EITHER arrival order relative to a
  reopen, with no credit or reopen-reset state to leak. Every other
  server's close-time publish (a real, if late, backlog answer) still
  counts exactly as before, and a genuinely clean, versioned answer is
  still delivered, never withheld.
  Separately, zizmor's dynamically-registered `textDocument/didSave` (which
  re-audits and republishes, the same surplus shape as opengrep's save
  rescan) is given the existing `rescansOnSave` marker now, ahead of that
  registration being honoured — `applyDynamicCapabilities` does not yet map
  a dynamic didSave registration to anything, so this has no runtime effect
  today, but needs no further change once it does.
