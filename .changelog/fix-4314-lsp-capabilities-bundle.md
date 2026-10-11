---
section: Fixed
audience: user
---

- **LSP warms again in the published package (closes #4314)** — 4.4.2 loaded the LSP stack through a computed `import()` that esbuild could not inline, so every session logged `LSP warm failed: Cannot find module './lsp/capabilities.js'` and the LSP-backed tools went dead. The import is a literal again, and a packaging test now fails the build if any shipped file dynamic-imports something the tarball does not carry.
