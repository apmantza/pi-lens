---
section: Changed
audience: user
---

- **Idle eviction is named for every server, with a generic window variable (refs #3645)** — the timer, shutdown reason and ledger kind are no longer TypeScript-named (`lsp-idle-eviction` replaces `ts-idle-eviction`), and `PI_LENS_LSP_IDLE_EVICT_MS` sets the shared idle window. `PI_LENS_TS_IDLE_EVICT_MS` keeps its meaning and is read when the generic variable is unset or invalid; the 20-minute default is unchanged.
