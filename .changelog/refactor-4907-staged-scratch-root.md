---
section: Changed
audience: internal
---

- The commit gate's staged-delta read now makes its scratch directory under `scannerReportParentDir()`, the shared scanner temp root, instead of its own `os.tmpdir()` join, so a harness that owns `PI_LENS_TEST_SCANNER_TMPDIR` sees and sweeps it. (refs #4907)
