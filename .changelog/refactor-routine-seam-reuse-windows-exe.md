---
section: Changed
audience: internal
---

- Every spawn of a System32 executable (`taskkill`, `cmd`, `chcp`, `tar`, `powershell`) in `safe-spawn`, the LSP teardowns and the installer now takes its path from `windowsExe` instead of a hand-built `%SystemRoot%` string, and `windowsExe` builds a Windows path whatever host runs it (refs #4907).
