---
section: Added
audience: internal
---

- **The test harness opts the loaded extension copy out of arming the orphan backstop.** `startPiSession` holds `PI_LENS_DISABLE_ORPHAN_BACKSTOP=1` across a tier-2 session start and `scheduleUntrackedOrphanSweep` reads it at arm time, so a harness session cannot SIGKILL fixture processes whose owner tags point at pids the harness already reaped. The key is a harness knob, not a supported user setting: `vitest-setup` scrubs a shell's value, and the spelling and the literal `"1"` contract are pinned by `tests/support/pi-session.test.ts` and `tests/clients/env-boolean-knob-literals.test.ts`. (refs #5267)
