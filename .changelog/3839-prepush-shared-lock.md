---
section: Changed
audience: internal
---

- **The pre-push hook takes a shared test slot, not the whole machine (closes #3839)** — The hook's targeted vitest run now waits for one of the two shared lock slots, like `npm run test:targeted`, instead of the exclusive lock. A push no longer stalls behind, or stalls, another lane's targeted run; a full-suite run still excludes it.
