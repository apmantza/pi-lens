---
section: Fixed
audience: internal
---

- Guard MCP session bootstrap with a `createGenerationSource("mcp-session-bootstrap")` fence and `session_scope_transition` retirement so `_resetMcpSessionContext()` during an in-flight `loadBootstrapClients()` rejects the stale bootstrap instead of republishing `resolvedRuntime` or clearing a successor `contextPromise`, and expose `MAX_CONFIG_BYTES`-bounded `contributingConfigSources` digests (distinguishing absent from present-but-unreadable candidates) on `resolvePiLensConfig`.
