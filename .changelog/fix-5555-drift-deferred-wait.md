---
section: Fixed
audience: internal
---

- The DEFERRED auxiliary-resync drift case no longer shrinks the notify budget: the 50ms value armed a 250ms wedge timer, and a loaded runner that outlived it demoted the auxiliary mid-case and left the sweep with nothing to heal. The case now parks and releases the blocking write itself, and the `never-settling-wait` baseline row for the file is gone. (refs #5555)
