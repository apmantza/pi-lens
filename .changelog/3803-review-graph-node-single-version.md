---
section: Changed
audience: internal
---

- The `formal/review-graph-signatures/` model splits the graph's atomic
  `Extract` into the content read, a same-file dispatch write and the derived
  read, and checks `NodeSingleVersion`: one node never records its content and
  its imports/symbols from two versions. `SharedStore` selects the pre-#3552
  shared store, whose config violates the invariant; the merged run-local
  store passes (refs #3552, #3803).
