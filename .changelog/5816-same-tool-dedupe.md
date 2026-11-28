---
section: Fixed
audience: user
area: blockers
---

- **A second error from one tool at one place is now reported.** Two
  `helm lint` errors with no line used to show as one, and a later write could
  add an error and report no blocker. One tool's findings with different
  messages are now all listed, and a new `helm lint` or helm render error blocks
  even where only a port or tag differs. (refs #5816)
