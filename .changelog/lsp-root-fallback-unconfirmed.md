---
section: Fixed
audience: user
---

- `lsp_diagnostics` no longer reports "confirmed clean" for an empty result from a language server that needs a project and was given none (rust-analyzer on a `.rs` file with no `Cargo.toml`; csharp-ls, OmniSharp and FSAutocomplete likewise). The verdict is now unconfirmed and names why, in single-file, batch and directory output. Servers whose root markers are optional (lua-language-server, nixd, deno, and the rest), and files whose root resolved normally, keep their clean verdict. A rust file with no `Cargo.toml` inside a git repository reads "no project root found", not a refused `.git` (closes #3750).
