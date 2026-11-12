---
section: Added
audience: user
area: config
---

- **`PI_LENS_DISABLE_ORPHAN_BACKSTOP=1` stops a process arming the orphan sweep.** The backstop runs 30 seconds after a session start and kills pi-lens-managed binaries whose owner tag names a dead pid, at most once per machine-wide 30-minute cooldown; the knob drops the arming timer for this process, so a test harness or a long-lived host that must not signal processes it does not own can opt out while `sweepUntrackedOrphans` and a forced sweep stay available. (refs #5267)
