---
section: Fixed
---

- **opengrep's rule-load republish no longer answers a running scan (closes #3490)** —
  When opengrep finishes loading its rules it sends `semgrep/rulesRefreshed`
  and republishes every file it has scanned. pi-lens now takes one counted
  publication back from each file that has already received one, including
  one still waiting out the 250 ms debounce. When the republish lands before
  the answer to a running scan, it is no longer mistaken for that answer, so
  an older scan's findings are no longer delivered after a re-edit. When the
  answer lands first, late delivery now waits for the republish and shows its
  content, which can be older. A file with no answer yet when the rules load
  is left as before. A `lsp_rules_refreshed` row in `latency.log` records how
  many files were rebaselined.
