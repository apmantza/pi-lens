---
section: Changed
audience: internal
---

- The type-aware lint lane enables `typescript/switch-exhaustiveness-check`, so a union switch whose `default:` would absorb a new member is flagged; the 11 runtime sites are listed explicitly or carry a reasoned disable (#5331).
