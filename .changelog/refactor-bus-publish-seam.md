---
section: Changed
audience: internal
---

- The eight `pi.events` publish functions (`publishFilesTouched`, `publishDiagnostics`, `publishDisposition`, the four format and autofix events, and the lens events) now run one `createBusPublisher` path in `clients/live-bus-emitter.ts` instead of eight hand-copied bodies; the rows, latches and `dbg` lines they write are unchanged, and the bus-row writer is private to that seam (refs #4907).
