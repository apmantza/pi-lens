---
section: Fixed
audience: user
area: blockers
---

- **The `withheld:` line now says whether its findings were re-checked on this write.** When some of them were recorded by an earlier check that the current write did not re-check, the line says that fixing the code cannot retire them and names `lens_diagnostics source=lsp path=<file>` as the call that settles them. An agent that read the old line re-read the file instead, which never changes that verdict, and could spend its whole budget there. (refs #5784)
