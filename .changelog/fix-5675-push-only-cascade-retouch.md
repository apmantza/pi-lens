---
section: Fixed
audience: user
area: lsp
---

- **The cascade now re-asks a push-only server about dependents it answered before your edit.** A server such as jdtls republishes a dependent when its own model changes, not when asked, so importers of an edited Java file stayed unconfirmed every time. The cascade now re-sends the dependent once per run and reads the answer. A server that stays silent still leaves the dependent unconfirmed, never clean. (refs #5675)
