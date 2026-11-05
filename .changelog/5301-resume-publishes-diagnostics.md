---
section: Fixed
audience: user
---

- A resumed session now publishes its restored diagnostics on `pilens:diagnostics`, so an extension that listens on the bus sees the same findings as the widget instead of nothing until the next write (refs #5301).
