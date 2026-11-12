---
section: Fixed
audience: internal
---

- **The server-teardown admission re-check now classifies each admitted file once.** Four admitted rows named three files, and the guard read and parsed each file again per row and again for the mechanism, so the case cost 1.07 s on Linux and timed out once at 5000 ms on the Windows leg (#5508). It now reads and classifies each distinct file once and checks every row against that one classification, which cut it to 0.22-0.31 s, and the case carries a scaled budget for a loaded runner. Every row is still re-checked, and a new case pins that one binding's close evidence no longer carries another's. (refs #5508)
