---
section: Changed
audience: internal
---

- `Targeted tests (advisory)` is gone from PR CI: its selection caught the failing file on 26.7% of real Unit reds (#3215), so the full Unit suite stays the only test gate. The changed-test shuffle (#4397) is now its own advisory job, `Changed tests shuffled (advisory)`, with only the setup it needs (refs #3215).
