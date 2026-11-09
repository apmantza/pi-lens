---
section: Fixed
audience: user
area: lsp
---

- **Edits to a project outside the session folder now get language server diagnostics.** An edit to a file in a sibling project (an adopted root) used to report "not analyzed" even while its language server ran. Language servers that run project code, such as rust-analyzer, now start there only when pi itself would trust that project: a saved decision on it or a parent folder, pi's default for a folder without `.pi` resources, or `defaultProjectTrust`. They no longer borrow the session's trust. (refs #5469)
