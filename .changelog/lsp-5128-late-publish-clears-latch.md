---
section: Fixed
audience: user
---

- **A custom language server that publishes late is no longer stuck as unsupported**: a custom push-only server that had not published by the end of the first-contact wait was latched diagnostics-unsupported for the whole session, so it never reported findings and one report could list a finding beside `unsupported=1`. A publish at any time now clears the mark, and a server that has not published reads as unconfirmed (`inconclusive`), not unsupported (#5128, #5123).
