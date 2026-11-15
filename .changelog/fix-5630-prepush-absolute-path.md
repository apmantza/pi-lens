---
section: Fixed
audience: internal
---

- The pre-push hook puts this checkout's `node_modules/.bin` first as an absolute path, so a test spawn from another directory finds `ast-grep` instead of failing `ENOENT` (refs #5630).
