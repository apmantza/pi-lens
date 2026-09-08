---
section: Fixed
---

- **Custom LSP servers that never publish diagnostics are navigation-only, not timed out (closes #2765)** — a custom server with no pull-diagnostics provider gets one bounded first-contact push wait per session; silence for the full push budget latches it navigation-only (no wait on later files, a distinct summary bucket, never counted clean), a publish latches it push-capable, concurrent first touches share the one probe, and a hook-deadline cutoff stays unconfirmed instead of latching.
- A rejected or shutdown-aborted shared first-contact probe now fails closed for every waiting touch, clears its single-flight entry, and can be retried without latching navigation-only.
