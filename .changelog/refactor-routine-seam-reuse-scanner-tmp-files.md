---
section: Changed
audience: internal
---

- SpotBugs' `-output` file, PSScriptAnalyzer's `-File` script and the ast-grep baseline scratch directory now take their parent from `scannerReportParentDir()` instead of a bare `os.tmpdir()`, so a harness-owned scanner root also catches what a killed run strands; production still writes to `os.tmpdir()` (refs #4907).
