---
section: Fixed
audience: user
---

- **Late authored findings still block commits.** Checks that finish after the tool-result wait expires now record their blockers and disclose them through the writing session's advisory queue; their findings rows no longer claim inline delivery. (#5165)
