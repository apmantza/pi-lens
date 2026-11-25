---
section: Fixed
audience: internal
---

- The Lombok case in `tests/clients/lsp/runtime-install-discovery.test.ts` no longer pays the `java` PATH probe's one-time cold start (a lazy import and a real JVM start) inside its 5 s cap, so it stops timing out on a loaded CI shard. (refs #4909)
