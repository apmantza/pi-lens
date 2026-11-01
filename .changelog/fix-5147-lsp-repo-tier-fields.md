---
section: Security
audience: user
---

- **An untrusted project can no longer set `args` or other launch fields of your LSP servers (#5147)** — a `.pi-lens.json` from a project pi has not marked trusted could set `lsp.servers.<id>.args` for a server declared in your global config, and the flags reached the server's argv. Without trust a project may now set only `name` and `extensions`; `args`, `rootMarkers`, `covers`, `env`, `initializationOptions`, `command` and any field pi-lens does not recognise are refused with one `lsp-registry-decision` record each, for `lsp.servers` and `lsp.serverOverrides`. A trusted project and a global-only config behave as before.
