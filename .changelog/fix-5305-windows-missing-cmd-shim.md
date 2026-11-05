---
section: Fixed
audience: user
---

- **On Windows, a missing project-local language-server `.cmd` no longer blocks the PATH server or the managed install (closes #5305)** — when a project had no `node_modules/.bin/pyright-langserver.cmd` (or the `.cmd` for the YAML, Bash, Docker, HTML, CSS, PHP, Prisma, Vue, Svelte or Fish server), pi-lens treated the absent file as an installed server, failed with a runtime error, and never tried the server on PATH or installed one. An absent local `.cmd` is now skipped like any other missing candidate. Thanks to ProphetOfDoom-PoD for the report and reproduction.
