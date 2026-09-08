---
section: Fixed
---
- **`scripts/npm-retry.mjs` annotates `infra: registry unreachable` only for network-shaped failures (closes #2684)** — a deterministic npm failure (`ERESOLVE`, `E404`, `EINTEGRITY`, `ETARGET`) now stops after one attempt with a plain "failed after N attempt(s)" line and the exit code preserved, while timeouts, spawn errors and `NET_PATTERN` matches (shared with `scripts/lib/ci-failure-classifier.mjs`) keep the retry backoff and the infra annotation; a test pins that the plain line never matches the auto-rerun classifier.
