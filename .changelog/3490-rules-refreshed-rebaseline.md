---
section: Fixed
---

- **opengrep's rule-load republish no longer answers a running scan (closes #3490)** —
  When opengrep finishes loading its rules it sends `semgrep/rulesRefreshed`
  and republishes every file it has scanned. pi-lens now takes one counted
  publication back from each file that already had one, so that republish is
  not mistaken for the answer to a scan still running, and an older scan's
  findings are no longer delivered after a re-edit. A file whose first answer
  had not arrived when the rules loaded is left as before. A
  `lsp_rules_refreshed` row in `latency.log` records how many files were
  rebaselined.
