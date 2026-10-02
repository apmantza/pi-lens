---
section: Fixed
audience: internal
---

- **Pre-push no longer treats a failing test that prints the lock wrapper's `[with-test-lock] ` prefix as lock contention (closes #3738)** — a lock timeout is now recognised only from wrapper-only stderr, so `PI_LENS_PREPUSH_LOCK_SKIP=1` cannot push a red test.
