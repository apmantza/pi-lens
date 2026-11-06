---
section: Fixed
audience: user
area: host
---

- **A resumed session now publishes its restored diagnostics on `pilens:diagnostics`.** An extension that listens on the bus sees the same findings as the widget, instead of nothing until the next write. (refs #5301)
