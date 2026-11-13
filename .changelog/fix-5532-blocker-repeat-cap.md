---
section: Fixed
audience: user
area: blockers
---

- **A blocker you cannot fix now reaches the agent in full at most three times.** After that, each prompt gets a one-line pointer to `lens_diagnostics` for it, however many other blockers are raised or fixed meanwhile. The blocker stays listed there and still blocks a `--lens-guard` commit, a fix stops the pointer at once, and a blocker re-raised with changed content gets three full deliveries again. (refs #5532)
