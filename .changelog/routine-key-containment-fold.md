---
section: Changed
audience: internal
---

- Five hand-written `key === root || key.startsWith(`${root}/`)` containment tests (LSP client-root overlap in two places, the blocker sweep's root test, `findModuleForPath`, the `lens_diagnostics` directory scope) now ask `isWithinForm`, the path owner (refs #4907).
