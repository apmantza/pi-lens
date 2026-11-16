---
section: Fixed
audience: user
area: runners
---

- **Prisma and Vite+ project edits no longer start an extra process per save.** The prisma and oxlint runners probed `prisma --version` and `vp --version` on PATH and kept no answer, so a tool that was slow to start or failed its probe cost every edit again. Both now read the shared per-project verdict like every other runner. (refs #5410)
