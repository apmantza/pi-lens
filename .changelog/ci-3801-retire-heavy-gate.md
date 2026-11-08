---
section: Removed
audience: internal
---

- Retired ci.yml's `heavy-gate` job (`Heavy advisory gate (advisory)`), `scripts/ci-heavy-gate.mjs` and ci-verdict's deferred-row list. No job had waited on the gate since #5275, and it was never a required check; an older head's gate row still classifies as advisory. (refs #3801)
