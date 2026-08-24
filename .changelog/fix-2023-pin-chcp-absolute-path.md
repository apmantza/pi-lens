---
section: Fixed
---

- **Windows `.cmd`/`.bat` spawns no longer fail when System32 is absent from the child PATH (closes #2023)** — The cmd.exe wrapper prefixed every spawn
  with a bare `chcp 65001 &&`. When the child environment's PATH could not
  resolve `chcp.com`, the lookup failed and `&&` short-circuited, so the whole
  spawn exited 1 with empty output. chcp is now invoked via its pinned
  `%SystemRoot%\System32\chcp.com` absolute path and chained with `&`, so a
  code-page failure can never suppress the real command.
