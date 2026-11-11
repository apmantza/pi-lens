---
section: Fixed
audience: user
area: runners
---

- **Formatters now find their tool the same way the linters do.** A formatter no longer runs a parent directory's Python virtualenv, and a broken copy on PATH no longer hides a working managed install of shfmt, taplo, ktlint, ktfmt, typstyle, black, google-java-format or cljfmt. A tool whose version check fails is reported as unavailable instead of failing on every file. (refs #5410)
