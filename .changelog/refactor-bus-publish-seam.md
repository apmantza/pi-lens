---
section: Changed
audience: internal
---

- The eight `pi.events` publish functions (`publishFilesTouched`, `publishDiagnostics`, `publishDisposition`, the four format and autofix events, and the lens events) now run one `createBusPublisher` path in `clients/live-bus-emitter.ts` instead of eight hand-copied bodies; the rows, latches and `dbg` lines they write are unchanged, and `tests/clients/bus-producer-coverage.test.ts` refuses a producer that writes its own `bus-events.log` row (refs #4907).
