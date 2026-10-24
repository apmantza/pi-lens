---
section: Fixed
audience: user
---

- **A timed-out read-only LSP probe no longer keeps its server busy** — a tsserver `projectInfo` probe (the warm-attach membership check and the first-open project-identity sample) that the server never answered stayed pending forever: no `$/cancelRequest` was sent, the connection counted as busy, and the client could never be evicted or make room for another server (#4801). The probe is now cancelled on the wire and released as soon as its 2.5 s ceiling passes.
