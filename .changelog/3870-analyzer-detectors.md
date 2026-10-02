---
section: Added
audience: internal
---

- **The log analyzer reports the live-session smells (refs #3870)** — `scripts/analyze-pi-lens-logs.mjs` gains the D1-D16 detectors and tightens E1-E5: LSP failures match only the production failure lines, so a worktree name in a path no longer counts; blocks are split from warns; a bypassed range mismatch is not a stale read; starts count from `session_start fired` with the build commit; bash commands are not projects. Test pollution counts only rows naming a test home (`witness-home`, `pi-lens-test-*`), never a real session's worktree. Stale test verdicts are judged per session, and a `--since` window keeps the session start and read evidence that precede it. The dead `session.rotations` counter and read-guard fields are gone. The analyzer stays read-only and imports no `clients/*.js`.
