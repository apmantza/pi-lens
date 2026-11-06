---
section: Fixed
audience: user
area: lsp
---

- **On Windows, a missing project-local server `.cmd` no longer blocks the PATH server or install.** When a project had no `node_modules/.bin/pyright-langserver.cmd` (or the `.cmd` for the YAML, Bash, Docker, HTML, CSS, PHP, Prisma, Vue, Svelte or Fish server), pi-lens treated the absent file as an installed server and failed with a runtime error. The Python server never reached its PATH server, and the Node-based servers never reached their managed install. An absent local `.cmd` is now skipped like any other missing candidate. Thanks to ProphetOfDoom-PoD for the report and reproduction. (refs #5305)
