---
section: Fixed
audience: internal
---

- The two refusal vocabularies in `clients/language-registry.ts` now sort with `compareOrdinal`, clearing master's SonarCloud S2871 red; the order of today's kinds and language ids is unchanged (refs #5135).
