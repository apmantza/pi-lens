---
section: Fixed
audience: internal
---

- The idle-eviction doc's `result`, `reason`, `respawn` and `coverage` cells now change only after two nights agree, a night that could not spawn a server leaves its row alone, and the nightly seed step restores the doc with the matrix, so one night's reading no longer flips a row (opengrep on 2026-11-14) and a move between `unavailable` and `eligible` (csharp, dart and elixir on 2026-11-06) waits for its second agreeing night. A census names the hold or the reason for every generated measured column. (refs #5667)
