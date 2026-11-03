---
section: Fixed
audience: user
---

- **LSP navigation now reports request timeouts as errors instead of empty results.** Preserve timeout details when tools reuse a service across module evaluations. A definition timeout still tries the local documentSymbol fallback and discloses the timeout when recovery succeeds.
