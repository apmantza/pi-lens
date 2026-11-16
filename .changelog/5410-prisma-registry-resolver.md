---
section: Fixed
audience: user
area: runners
---

- **Editing a Prisma schema no longer starts a second prisma process on every save.** The runner probed `prisma --version` on PATH before each validate and kept no answer, so a prisma that was slow to start or failed its probe cost every edit again. It now reads the shared per-project verdict like every other runner, then falls back to a package manager's global copy and the cache-only `npx --no prisma`. (refs #5410)
