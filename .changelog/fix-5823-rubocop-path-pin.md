---
section: Fixed
audience: internal
---

- The RuboCop status-2 test case now pins its own `PATH` to the fixture, so a host-installed `rubocop` cannot shift its queued spawn results. (refs #5823)
