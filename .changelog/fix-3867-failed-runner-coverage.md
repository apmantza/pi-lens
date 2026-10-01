---
section: Fixed
---

- A pull of a file whose only primary linter timed out or failed to spawn now
  reports the coverage notice instead of a silent empty result. The notice keys
  on `failureKind`, so a run whose own findings failed it (`blocking_diagnostics`)
  still counts as coverage (refs #3867).
