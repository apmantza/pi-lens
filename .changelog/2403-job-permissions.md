---
section: Security
---

- **Scope workflow permissions per job (closes #2403)** - install-smoke and label-sync workflows now deny token permissions by default and grant only checkout reads or post-merge label/comment writes to the jobs that use them.
