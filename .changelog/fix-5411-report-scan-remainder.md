---
section: Fixed
audience: user
area: runners
---

- **Report scanners now answer the same way.** Opengrep and jscpd each ran their
  own copy of the report file rules, so the same run read differently per
  scanner. An opengrep scan that finished and wrote a complete report was thrown
  away for exiting badly, an opengrep scan that found nothing read as a failure,
  and a jscpd run that never started came back empty and left no record. All
  four scanners now share one verdict: a complete report is read whatever the
  exit, a clean run with no report is an empty scan that claims no files, and
  every other outcome is a failure with its reason on the record. (refs #5411)
