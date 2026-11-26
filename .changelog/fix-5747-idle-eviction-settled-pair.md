---
section: Fixed
audience: internal
---

- **The nightly idle-eviction writer keeps a settled two-night pair without promoting on a failing night.** A night that could not qualify retains the settled pair in refresh state while requiring a qualifying current night before promotion; only a hard veto, server removal or policy change clears the pair.
