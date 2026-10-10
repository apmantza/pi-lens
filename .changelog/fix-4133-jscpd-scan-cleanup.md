---
section: Fixed
audience: internal
---

- Keep a killed jscpd scan's report directory inside a harness-owned root: the MCP test harness points `PI_LENS_TEST_JSCPD_TMPDIR` at its isolation dir, so a child SIGKILLed mid-scan no longer strands a `pi-lens-jscpd-*` entry in the shared tmpdir and reds `tmp-fixture-hygiene` (refs #4133). The scan-setup cleanup guard is retained as defence-in-depth.
