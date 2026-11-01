---
section: Security
audience: user
---

- **An untrusted project can no longer set `args` or other launch fields of your LSP servers (#5147)** — a `.pi-lens.json` from a project pi has not marked trusted could set `lsp.servers.<id>.args` for a server declared in your global config, and the flags reached the server's argv. Without trust a project may now set only `name`; if it sets any other field (`args`, `rootMarkers`, `covers`, `extensions`, `env`, `initializationOptions`, `command`, `enabled`, `role`, or a field pi-lens does not recognise) on a server, that server is not started for the project, so a repo cannot start your server on flags it chose or with your own flags stripped. A refused field under `lsp.serverOverrides` drops only the project's fields: your own global override for that built-in still applies, wrapper `command` included, and the built-in stays on. A server entry with no `extensions` list (such as `{"name":"x"}`) is no longer registered, so it cannot make server selection throw `server.extensions is not iterable`. One `lsp-registry-decision` record per field says so. A trusted project and a global-only config behave as before.
