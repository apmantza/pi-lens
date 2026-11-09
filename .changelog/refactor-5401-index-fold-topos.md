---
section: Changed
audience: internal
---

- Routes the last raw separator fold in `index.ts` (the `lens-health` sample path) through `toPosix`, and empties the shape-A census pin in `tests/config/path-key-fold-sweep.test.ts`. The output is byte-identical (refs #5401).
