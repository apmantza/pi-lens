---
section: Fixed
---

- **Surface a crashed pi hook handler instead of swallowing it silently (refs #2884)** — the nine `index.ts` catch sites that absorb a handler crash (`session_start`, `session_before_fork`, `observed_settled_sweep`, `observed_ledger_refresh`, `agent_end`, `turn_end`, the `agent_settled` deferred-mutation drain, `quiet_window`, and `message_end`) now route through one shared `surfaceHandlerCrash` guard: production keeps the swallow but leaves one bounded `hook-handler-crash` degradation row per handler per session, and under the test runner the crash is rethrown so the awaiting test fails instead of resolving as if the handler had completed. The fire-and-forget `quiet_window` catch records the row without rethrowing, so a crash cannot terminate the pi host with an unhandled rejection.
