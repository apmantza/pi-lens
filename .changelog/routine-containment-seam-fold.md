---
section: Fixed
audience: user
area: lsp
---

- **A session rooted at `/` keeps its `lsp.disabledServers` denial.** The LSP session-root registry answered "no config" for every file under a root whose path is the filesystem root (a container's `WORKDIR /`), so a language server the operator had turned off could still attach. It now uses the containment check the rest of that module already used. Four other inline containment checks (C/C++ include resolution, the bundled query root, the LSP root-walk stop directory and the live-peer root match) go through the shared path helpers with the same answers. (refs #4907)
