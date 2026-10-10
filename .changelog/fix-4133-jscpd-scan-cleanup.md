---
section: Fixed
audience: internal
---

- Keep a killed scanner scan's report directory inside a harness-owned root: one shared seam (`PI_LENS_TEST_SCANNER_TMPDIR`, `clients/scanner-temp-root.ts`) now parents jscpd, gitleaks, opengrep, and trivy report directories, and the MCP and real-pi test harnesses apply owned scanner roots after caller environment overrides, so even a TMPDIR-overriding child SIGKILLed mid-scan no longer strands a `pi-lens-<scanner>-*` entry in the shared tmpdir and reds `tmp-fixture-hygiene` (refs #4133). The scan-setup cleanup guard is retained as defence-in-depth.
