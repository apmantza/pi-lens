---
section: Fixed
---

- **Keep side-effect autofixes out of target identity (refs #2957)** — Pipeline results no longer claim a post-write hash for the target when an autofix changed only another file.
