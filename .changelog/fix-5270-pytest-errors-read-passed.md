---
section: Fixed
audience: user
---

- **A pytest run with errors beside passes no longer reads as passed (#5270)** — `1 passed, 1 error` (a fixture or collection error) was counted as a clean pass and cleared the `--lens-guard` test-failure blocker. pi-lens now treats pytest's `error` count, and any non-zero exit that counts no failed test, as a runner error, and no longer falls back to vitest's stdout when the report file is missing.
