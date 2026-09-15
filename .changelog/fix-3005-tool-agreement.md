---
section: Fixed
---

- **Require project tool agreement before autonomous writes (refs #3005)** — autofix, formatting, and deferred LSP quickfixes use one cached agreement seam and a complete declarative tool population. Node agreement follows each resolver's package identity, including markdownlint-cli2. Missing, unreadable, unparseable, and unsupported project evidence declines conservatively, with bounded degradation records. Lockfile evidence declines with distinct reasons when a version is unparseable or a legal shape is unsupported. LSP quickfix agreement preserves the diagnostic producer from `source`, falling back to `serverId`, while unsupported identities remain fail-closed.
