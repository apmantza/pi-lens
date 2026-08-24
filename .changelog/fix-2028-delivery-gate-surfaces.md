---
section: Fixed
---

- **Register remaining agent-facing delivery surfaces (#2028)** — The per-edit 🔴 STOP block now drops blockers whose cited file no longer exists, so a deleted file's stale blocker no longer re-blocks the agent with no remediation. All five previously unregistered surfaces (stop blocker, `lsp_diagnostics` output, git-guard verdicts, read-guard preflight errors, thrashing notices) are registered in the finding-delivery gate registry.
