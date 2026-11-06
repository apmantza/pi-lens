---
section: Fixed
audience: internal
---

- Ledger-subject assertions in the #4530 trust suite, the #4760 auxiliary-root decline, the bare-`tsc` trust refusal, the pi-agent staging-root decline, and the two #4535 disk-change rows now compare the `degradation-ledger`'s bounded subject instead of the raw `kind:path` key, so a long checkout or TMPDIR no longer reddens them in the pre-push hook (refs #5246).
