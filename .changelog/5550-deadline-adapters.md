---
section: Removed
audience: internal
---

- Remove `withTimeout` and `withinRemaining` from `clients/deadline-utils.ts`. Both only preset `withDeadline`'s options, and none of their 11 callers is a hook await, so each now names the options on `withDeadline`; behaviour is unchanged. Two cases prove that a `bounded()` deadline, not only the turn's abort, cancels the real diagnostic pull under the persistent re-verify touch and the enrichment's `getDiagnostics`. (refs #5550)
