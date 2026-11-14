---
section: Fixed
audience: internal
---

- Make the Java trust-flip probe case in `session-repository-trust-4530.test.ts` warm its own lazy probe helpers, so it no longer passes only after a sibling case loaded them; it was red under the nightly shuffle seeds 202 and 424. (refs #5607)
