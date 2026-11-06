---
section: Fixed
audience: internal
---

- The nightly `silentOnClean` drift check no longer files `silent-not-marked` for an auxiliary server (fallow, ast-grep, opengrep, zizmor, typos), and the comments and matrix prose no longer say native TS7 publishes on clean (refs #5348). The native TS7 marker stays `false`.
