---
section: Fixed
audience: user
area: host
---

- **The deferred-tools log field now states the host's deferral capability.**
  The `tool_set_mutation` row in `latency.log` reported that capability as
  false on every supported pi host, because it read a compat flag only the
  long-unsupported pi 0.80.10 build shipped. It now reads pi's own two gates:
  `compat.supportsToolSearch` for OpenAI Responses models, and
  `compat.supportsMidConvoSystemMessages` together with
  `compat.supportsMidConvoToolChanges` for Anthropic models. So the row
  reports true for the models whose host really takes deferred tool
  definitions. (refs #5361)
