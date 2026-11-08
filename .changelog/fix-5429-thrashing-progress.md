---
section: Fixed
audience: user
area: tools
---

- **Three successful edits to one file no longer warn as thrashing.** The 🔴 THRASHING line means the same call keeps repeating with no progress, and it now checks the call itself: only a result the host reported as failed, or one that ran with the same arguments as the call before it, counts as no progress. Edits that each change the file, and reads at different offsets, are progress, so a working sequence stays quiet while a stuck retry loop still warns. (refs #5429)
