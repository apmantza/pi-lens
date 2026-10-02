---
section: Fixed
audience: internal
---

- **Pre-push now blocks instead of silently skipping the targeted tests when the machine-wide test lock stays busy (closes #3717)** — the failure names the holder, the lock path and the retry options; `PI_LENS_PREPUSH_LOCK_SKIP=1` is the explicit opt-out and appends a `lock-skip` line to `pre-push.log`.
