---
section: Fixed
audience: internal
---

- The Stryker nightly no longer launches a sampled range whose verified count alone exceeds the affordable mutant allowance. A retry or a first sample now takes the next-ranked range that fits, and when none fits it reports a zero-mutant outcome without launching Stryker. A failed count pass still launches its range unverified (refs #4171).
