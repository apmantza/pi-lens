---
section: Fixed
audience: internal
---

- The Stryker nightly no longer launches a sampled range that alone holds more mutants than the affordable allowance. A retry or a first sample now takes the next-ranked range that fits, and when none fits it reports a zero-mutant outcome without launching Stryker (refs #4171).
