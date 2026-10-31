---
section: Fixed
audience: internal
---

- **LSP sweeps, warm-ups, batches and project scans no longer leave an abort listener per file (refs #4907).** Five private races of a promise against the caller's `AbortSignal` added a listener and never removed it (the warm-up and its retry backoff, the per-file pre-open of a sweep, the analyzer race of a project scan, and each file of an `lsp_diagnostics` batch), so a signal that outlives one call kept a dead closure for every file it served. All seven races now go through one `untilAborted` in `clients/deadline-utils.ts`, which releases its listener when the race settles, and `tests/clients/abort-listener-release-sweep.test.ts` refuses any abort listener site it does not admit, including a computed method name or a non-literal event (an aliased import and a method fetched by `Reflect.get` stay an accepted gap).
