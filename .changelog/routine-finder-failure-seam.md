---
section: Fixed
audience: user
area: install
---

- **A failed `which` or `where` no longer marks pnpm, yarn, bun, npm or Java as absent.** The package-manager and Java probes now read a finder that could not spawn (EACCES, EMFILE) as a transient rejection and re-probe after the cooldown, as the formatter probe already did; before, one such failure latched the tool as not installed until the next session. (refs #4907)
