---
section: Fixed
audience: user
area: host
---

- **The deferred-tools log field now states how the host sends this model's tools.**
  The `tool_set_mutation` row in `latency.log` reported that capability as
  false on every supported pi host, because it read a compat flag only the
  long-unsupported pi 0.80.10 build shipped. It now reports true exactly when
  pi's own transport leaves the request's tool list empty or partial — the
  Responses-family tool-search gate, the Responses-family additional-tools
  gate, the Anthropic mid-conversation tool-change gate, and the
  chat-completions tool-additions gate — and false when the host resends the
  full tool list on every turn. (refs #5361)
