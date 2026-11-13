---
section: Fixed
audience: internal
---

- The turn-id observability test drains every log sink before it removes its temp home, so a row queued by its last case no longer recreates the directory during teardown (refs #5569).
