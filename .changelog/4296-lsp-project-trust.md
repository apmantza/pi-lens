---
section: Fixed
audience: user
---

- **TypeScript and Typst LSP servers no longer run project-supplied code under unknown project trust.** The TypeScript LSP skips a project's own `tsserver.js` and falls back to pi-lens-managed TypeScript unless pi marks the session project trusted (closes #4296). Adopted projects always use a non-project compiler; if no absolute valid compiler resolves, the classic TypeScript server is refused. Tinymist now requires project trust because it runs the project's Typst `plugin()` wasm; both refusals emit the existing trust notice once per session.
