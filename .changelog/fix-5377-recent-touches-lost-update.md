---
section: Fixed
audience: user
area: blockers
---

- **Cross-process autoformat nudges keep every file.** Two writes landing in
  the same tick previously dropped one batch, so an agent could miss the
  "these files were autoformatted" note about one of them. (refs #5377)
