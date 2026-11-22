---
section: Fixed
audience: user
area: blockers
---

- **A false-positive mark made from a STOP block now hides that finding.** Marking
  what the block shows (the `[rule]` bracket as the rule, the rest as the message,
  no tool) used to anchor on an identity the finding never had, so the same
  finding came back on every edit. (refs #5709)
