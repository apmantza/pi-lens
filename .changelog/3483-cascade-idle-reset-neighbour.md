---
section: Fixed
---

- A cascade run no longer loses a dependent file when the LSP idle reset
  lands while neighbours are still being checked. Such a neighbour used to
  vanish from the run, so the run could read "clean", or list it as "… and 1
  more dependent file(s)" as if the output were only truncated. It is now kept
  as an unconfirmed neighbour ("Cascade diagnostics inconclusive … no clean
  result was confirmed"), and the cascade log row records
  `inconclusiveReason: "service-destroyed"` (closes #3483).
