---
section: Fixed
audience: internal
---

- **Fact-store bound test fills the session-fact cap directly** — the large-batch case no longer dispatches 4296 real files to fill the cap, so it stops running at its timeout on CI. The test also pins the dispatcher's own baseline write (refs #5307).
