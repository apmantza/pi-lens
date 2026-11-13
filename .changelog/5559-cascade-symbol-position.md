---
section: Fixed
audience: user
area: lsp
---

- **Public Rust functions now bring their callers into the neighbour cascade.** The cascade asked the language server at the `pub` keyword, where rust-analyzer returns no references, so an edit to a `pub fn` listed no dependents. It now asks at the function name, and methods in the other tree-sitter languages get the same position. (refs #5559)
