---
section: Fixed
audience: user
---

- **Runner status contract: findings-failed runs carry `failureKind: "blocking_diagnostics"` (closes #3781)** — Forty-two runners reported a run whose findings failed the check as a bare `status: "failed"`, the same thing a broken runner reports. Every such result is now built by `findingsResult`, which tags it `blocking_diagnostics` without changing its status, so every fallback chain is unchanged. The `pilens_analyze` MCP `latency.runners[]` rows now include `failureKind`. A `failed` row with any other kind, or with none, means the runner produced no usable result. A population test drives every registered runner through the real dispatcher, so a new runner cannot skip the contract. `prisma validate` output without prisma's `Validation Error Count` trailer (for example an npm 404 while fetching prisma) is now reported as a warning-level tool failure, not a blocking schema finding.
