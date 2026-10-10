---
section: Fixed
audience: internal
---

- Keep the jscpd report directory inside the scan cleanup guard, so a throw while reading project-controlled ignore files still removes it (refs #4133). The guard and its regression test were dropped by a merge; both are restored.
