---
section: Fixed
audience: user
---

- **A resumed session publishes its restored diagnostics on `pilens:diagnostics` (closes #5301)**: an extension that listens on the bus now sees the same findings as the widget, instead of nothing until the next write.
