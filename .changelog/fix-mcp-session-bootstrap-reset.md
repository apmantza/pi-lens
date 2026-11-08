---
section: Fixed
audience: internal
---

- Guard MCP session bootstrap with an epoch ticket and pending-runtime retirement so `_resetMcpSessionContext()` during an in-flight `loadBootstrapClients()` rejects the stale bootstrap instead of republishing `resolvedRuntime` or clearing a successor `contextPromise`, and expose read-time `contributingConfigSources` SHA-256/byte-length digests on `resolvePiLensConfig`.
