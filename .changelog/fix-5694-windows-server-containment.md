---
section: Fixed
audience: user
area: lsp
---

- **On Windows, more language servers now end when pi ends.** A server whose path held a space, such as PowerShell 7 under `C:\Program Files`, or one installed as an npm 9 or later `.cmd` shim, ran behind `cmd.exe`, so pi's exit ended only the wrapper and the server kept running. pi-lens now starts these servers as its own direct child, so Windows ends them with pi even when pi is killed. A server started through another wrapper, such as a pnpm shim or a shim that passes Node flags, still runs behind `cmd.exe` and can outlive pi; pi-lens records each one as `lsp-server-uncontained`. (refs #5694)
