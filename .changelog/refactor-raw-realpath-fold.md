---
section: Changed
audience: internal
---

- **Three hand-written realpath fallbacks now answer through the path-identity seam.** The probe-home tmpdir and real-home checks, the explicit analysis root of a fresh project run, and the git checkout `root` and `commonDir` now share `realpathOrResolve` and `isWithinIdentity`, and the three `PRE_4689` `raw-realpath` pins are gone. An answer changes only for a missing path spelled through a symbolic link; the fresh-run root answers as before, because its directory check runs first. (refs #4907)
