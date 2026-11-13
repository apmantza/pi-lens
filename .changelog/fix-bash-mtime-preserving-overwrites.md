---
section: Fixed
audience: user
area: host
---

- **Bash overwrites that keep an old mtime are now seen.** A recognized `mv` or `cp -p` into a file that was clean before the command now reaches the normal dispatch path, including from a package-subdirectory session, even when the destination keeps its source's old modification time. A file you had already edited is still judged by mtime. (refs #5552)
