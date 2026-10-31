---
section: Changed
audience: internal
---

- The nightly live cascade lane gains a typescript-go rename phase: it restores the exporter, moves it through `LSPService.renameFile` and requires each importer to reach the verdict its file calls for (refs #1712).
