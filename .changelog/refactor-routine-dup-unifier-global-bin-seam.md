---
section: Changed
audience: internal
---

- The installer's npm global-bin and pip user-base rungs now verify their candidates through one `firstVerifiedBinary` loop instead of two byte-identical copies of the access, project-trust and verification steps; resolution results are unchanged (refs #4907).
