---
section: Fixed
---

- **opengrep's save rescan and a scan queued across a rename no longer answer a later edit (refs #3482)** —
  A save sent to opengrep (the `lsp_diagnostics` tool's saved touch) makes
  it scan the file twice. pi-lens now expects the second publish, so it is
  no longer counted as the answer to the next edit, and an older version's
  findings are no longer delivered at turn end against the newer file.
  When a file is renamed away and back, the scanner's per-file counts now
  carry across the close: a scan still running at the close is counted
  whether it lands while the file is closed or after it reopens, and it no
  longer stands in for the reopened file's answer. The same holds for
  opengrep's rule-load republish when the file is closed and reopened
  before it lands.
  A scanner that publishes on every close (typos) is not yet covered
  (refs #3548).
