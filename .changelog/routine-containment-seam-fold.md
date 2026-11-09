---
section: Fixed
audience: user
area: lsp
---

- **A session rooted at `/` keeps its `lsp.disabledServers` denial.** The LSP session-root registry answered "no config" for every file under a root whose path is the filesystem root (a container's `WORKDIR /`), so a language server the operator had turned off could still attach. It now uses the containment check the rest of that module already used. Four other inline containment checks (C/C++ include resolution, the bundled query root, the LSP root-walk stop directory and the live-peer root match) now go through the shared path helpers. Their answers change only where the old inline check was wrong: a root at `/`, Windows drive and UNC roots, and case-insensitive spellings. (refs #4907)
