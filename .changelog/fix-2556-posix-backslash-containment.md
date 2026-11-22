---
section: Fixed
audience: user
area: security
---

- **A directory named with a backslash no longer counts as inside the project.** On Linux and macOS, a sibling directory such as `proj\evil` next to the session root `proj` was treated as part of it, so edits there got session treatment. (refs #2556)
