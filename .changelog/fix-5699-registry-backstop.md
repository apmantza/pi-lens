---
section: Fixed
audience: user
area: lsp
---

- **Recover orphaned language servers across the built-in registry.** The backstop derives command markers and Windows process images from each server's declaration, while retaining the existing platform ownership and process-start checks. On Windows a marker counts only as a process's own image or the script, jar or package it launches, never as part of a directory or another argument. (refs #5699)
