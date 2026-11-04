---
section: Fixed
audience: user
---

- **A failing test in a vitest 5 project no longer reads as passing, and no longer clears the `--lens-guard` commit blocker (closes #5257)** — vitest 5 writes its JSON report to a file instead of stdout, so every per-edit test run came back unreadable and was counted as "all tests passed". pi-lens now asks vitest for the report file, treats output it cannot read as a runner error, and clears a test-failure blocker only for a test file that ran and passed at least one test.
