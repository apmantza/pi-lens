---
section: Fixed
---

- **Never signal a pid pi-lens does not own (refs #2042)** — `safeSpawnAsync` verified nothing before putting a child's pid into the process-wide lifetime registry, so a `node:child_process` test double's invented pid (`2468`) was registered, never removed, and SIGKILLed at host exit; on ~10 % of CI runners that pid belonged to the job itself, which is where the unexplained exit-137 "infra kills" came from. One ownership predicate (`isOwnLiveChild`) now gates registration, the timeout process-group kill, and the LSP POSIX/Windows tree kills — folding away three sibling sign/exited guards — reading `/proc/<pid>/status` on Linux and requiring `PPid` to be this process; a live pid under another parent is refused and recorded once per call site in the degradation ledger.
