---
section: Fixed
---
- **`scripts/npm-retry.mjs` annotates `infra: registry unreachable` only for network-shaped failures (closes #2684)** — a deterministic npm failure (`ERESOLVE`, `E404`, `EINTEGRITY`, `ETARGET`) now stops after one attempt with a plain "failed after N attempt(s)" line and the exit code preserved, while timeouts, spawn errors, and the widened shared `NET_PATTERN` keep the retry backoff and origin/master's `failed 3 times` infra annotation; network evidence wins over a mixed deterministic code, and unknown non-network failures retain retry behavior.
