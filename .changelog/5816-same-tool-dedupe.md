---
section: Fixed
audience: user
area: blockers
---

- **A second error from one tool at one place is now reported.** Two
  `helm lint` errors with no line used to show as one, and a later write could
  add an error and report no blocker. A tool's findings with different messages
  now stay separate, including two helm render or rendered-manifest findings on
  one template. (refs #5816)
