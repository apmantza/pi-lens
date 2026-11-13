---
section: Fixed
audience: user
area: tools
---

- **A wedged formatter no longer starts a new child on every write.** Writes that one formatter handles in one project now wait their turn, so a hung child is never joined by a second one. Once a child runs out its own time, later writes skip that formatter for the session with a recorded reason, and a repeated deferred format failure is retried once. (refs #5549)
