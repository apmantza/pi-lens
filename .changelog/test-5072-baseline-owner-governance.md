---
section: Added
audience: internal
---

- A governance check now fails the suite when a checked-in baseline has no owner test, or an owner that never reddens on a planted stale row. It takes every tracked file, finds baselines by name, by an exported binding name, or by JSON rows that name repo files, and fails on any it cannot place. Twenty baselines are covered, each by a planted-stale-row cell in its owner (refs #5072).
