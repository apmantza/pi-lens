---
section: Fixed
audience: user
area: runners
---

- **Editing a Prisma or Vite+ file no longer starts an extra process per save.** The prisma and oxlint runners probed `prisma --version` and `vp --version` on PATH and kept no answer, so a tool that was slow to start or failed its probe cost every edit again. Both now read the shared per-project verdict like every other runner. (refs #5410)
