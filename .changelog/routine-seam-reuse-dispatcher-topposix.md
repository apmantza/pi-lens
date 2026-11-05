---
section: Changed
audience: internal
---

- **The dispatcher's code-like diagnostic path check folds backslashes through `toPosix` (refs #4907)** — `looksLikeDiagnosticCodePath` hand-rolled `.replace(/\\/g, "/")`; it now calls the shared seam, and the `path-key-fold-sweep` pin for `clients/dispatch/dispatcher.ts` is gone. Behaviour is unchanged.
