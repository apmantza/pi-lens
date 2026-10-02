---
section: Fixed
audience: internal
---

- Scoped root deregistration now takes one lease-waiting registry lock instead of a discarded synchronous attempt followed by a queued fallback (#3618), and the shared test teardown joins pending registry mutations, for a bounded time, before Vitest terminates the worker (refs #3617).
