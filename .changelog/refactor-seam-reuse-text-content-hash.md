---
section: Changed
audience: internal
---

- Six sites that hashed a decoded file text with their own `createHash("sha256")` now call `hashContentBytes` in `clients/content-stamp.ts`, the owner the bytes fold of #4541 left this half out of; every digest is unchanged. (refs #4907)
