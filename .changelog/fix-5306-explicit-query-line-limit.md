---
section: Changed
audience: user
area: lsp
---

- **A large file can now be checked with `lens_diagnostics source=lsp` on one path.** The new user-level key `lsp.queryMaxFileLines` (5000 to 40000, suggested 20000) raises the line limit of that single-file query only; per-edit, dispatch and batch checks keep 5000 lines and 2 MiB. A project `.pi-lens.json` cannot set it, and an out-of-range value is ignored with a warning. An explicit `waitMs` now waits past the server's own wait, up to 30000 ms. A file over the limit or a wait that runs out reads as too large or timed out, never as clean, and a language server whose wait ran out now reads as timed out even while a slower scanner is still running. (refs #5306)
