---
section: Fixed
---

- **Widget disposition reconciliation is admission-ordered (refs #1616)** — Marking a diagnostic disposition immediately reconciles the widget counts and retains suppressed findings as a visible bucket. Reconciliation now shares the same admission-ordered write tokens as dispatch, so a dispatch that was already in flight can no longer commit its pre-mark counts afterwards.
