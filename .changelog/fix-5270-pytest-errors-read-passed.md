---
section: Fixed
audience: user
---

- **A pytest run with errors beside passes no longer reads as passed (#5270)** — `1 passed, 1 error` (a fixture or collection error) was counted as a clean pass and cleared the `--lens-guard` test-failure blocker. pi-lens now treats pytest's `error` count, and exit 3 (an internal error or `pytest.exit`), as a runner error, and no longer falls back to vitest's stdout when the report file is missing. A passing run that exits 1 for its own threshold (`--cov-fail-under`) still reads as passed.
