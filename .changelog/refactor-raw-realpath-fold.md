---
section: Changed
audience: internal
---

- **Four hand-written realpath fallbacks now answer through the path-identity seam.** The probe-home tmpdir and real-home checks, the explicit analysis root of a fresh project run, and the git checkout `root` and `commonDir` used a raw `realpath` that kept the input spelling for a missing path; they now share `realpathOrResolve` and `isWithinIdentity`, and the three `PRE_4689` `raw-realpath` pins are gone. (refs #4907)
