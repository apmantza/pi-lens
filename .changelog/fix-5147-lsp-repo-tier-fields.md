---
section: Security
audience: user
---

- **An untrusted project can no longer set `args` or other launch fields of your LSP servers (#5147)** — a `.pi-lens.json` from a project pi has not marked trusted could set `lsp.servers.<id>.args` for a server declared in your global config, and the flags reached the server's argv. Without trust a project may now set only `name`; if it sets any other field (`args`, `rootMarkers`, `covers`, `extensions`, `env`, `initializationOptions`, `command`, or a field pi-lens does not recognise) on a server, that server is not started for the project, so a repo cannot start your server on flags it chose or with your own flags stripped. A refused field under `lsp.serverOverrides` drops the override and the built-in runs on its defaults, which also skips your own global override for that built-in until the project is trusted. One `lsp-registry-decision` record per field says so. A trusted project and a global-only config behave as before.
