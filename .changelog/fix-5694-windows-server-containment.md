---
section: Fixed
audience: user
area: lsp
---

- **On Windows, language servers now end when pi ends.** A server whose path held a space, such as PowerShell 7 under `C:\Program Files`, or one installed as an npm `.cmd` shim, ran behind `cmd.exe`, so pi's exit ended only the wrapper and the server kept running. pi-lens now starts such a server as its own direct child, so Windows ends it with pi even when pi is killed. (refs #5694)
