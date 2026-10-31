---
section: Fixed
audience: user
---

- **A cascade dependent whose only answer predates the edit no longer reads as clean**: a push-only language server that does not republish a dependent after the file it depends on changed could leave a broken dependent reported as a clean cascade; the run now names it unconfirmed instead.
