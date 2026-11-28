---
section: Fixed
audience: internal
---

- The idle-eviction `#5323` test loads its dist modules in `beforeAll`, so a cold import on a loaded machine no longer fails the case at 5 s. (refs #5826)
