---
section: Fixed
audience: user
area: runners
---

- **Linting a Vite+ project no longer probes `vp --version` on every edit.** The oxlint runner checked PATH for `vp` with no memory of the answer, so each save spent a process start, and a `vp` that failed its probe cost it again every time. It now reads the shared per-project verdict like every other runner. (refs #5410)
