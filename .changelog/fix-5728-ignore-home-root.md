---
section: Fixed
audience: user
area: lsp
---

- **Language servers now refuse project markers found in ancestors of the home directory.** TypeScript, HTML, Vue, Svelte, and CSS servers previously adopted config or lockfile roots located above the home directory instead of falling back to safer scopes. (refs #5728)
