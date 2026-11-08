---
section: Fixed
audience: user
area: runners
---

- **`.mts` and `.cts` source files are now scanned.** The startup source count, the circular-dependency scan, the duplicate-code (jscpd) re-scan and walk gate, and the review-graph module walk each kept a hand-written extension list that left out ES/CommonJS-module TypeScript (and the review graph also missed `.mjs`/`.cjs`); those files now answer through the one language-registry JS/TS source check. (refs #5446)
