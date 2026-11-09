---
section: Fixed
audience: user
area: runners
---

- **`.mts` and `.cts` files now count as source.** The startup source count, the duplicate-code (jscpd) re-scan and walk gate, and the review-graph module walk each kept a hand-written extension list that left out ES-module and CommonJS-module TypeScript; they now answer through the language registry's JS/TS source check. `.mjs` and `.cjs` files also now count at the startup file-limit count, in the review-graph walk and at the circular-dependency root gate. Circular-dependency scanning of `.mts` and `.cts` still waits on madge reading those extensions. (refs #5446)
