---
section: Fixed
audience: user
area: blockers
---

- **A blocker you cannot fix now repeats in full on at most three prompts.** After that, each prompt gets a one-line pointer to `lens_diagnostics` instead of the whole blocker again. The blocker stays listed there and still blocks a `--lens-guard` commit, a fix stops the pointer at once, and a blocker re-raised with changed content gets three full repeats again. (refs #5532)
