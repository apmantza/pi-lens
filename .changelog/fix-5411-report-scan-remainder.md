---
section: Fixed
audience: user
area: runners
---

- **A failed jscpd run is recorded, and an opengrep run with no report is empty.** Opengrep and jscpd each ran their
  own copy of the report file rules, so the same run read differently per
  scanner. An opengrep scan that exited 0 and wrote no report read as a
  failure, and a jscpd run that never started, or wrote a report it could not
  read, came back empty and left no record. All four scanners now share one
  verdict: a clean run with no report is an empty scan that claims no files,
  and every other outcome is a failure with its reason on the record. (refs #5411)
