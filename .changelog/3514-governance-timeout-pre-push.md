---
section: Fixed
---

- **Pre-push no longer times out on `vi-domock-undo` and `flake-shape-ratchet` under load (closes #3514)** —
  `vi-domock-undo`'s whole-tree case recomputed the same file's stripped
  source 3-4 times per file; it now strips once per file and reuses the
  result, and carries an explicit 30s budget. `flake-shape-ratchet`'s five
  detectors already shared one walk and one parse per file, but that shared
  cost was billed entirely to whichever `detector %s` case happened to run
  first; a `beforeAll` now pays it once, under its own budget, so no single
  detector's smaller timeout absorbs the other four's share. Neither
  detector's matching semantics changed.
