---
section: Fixed
audience: user
area: runners
---

- **A fixer that rewrites a file and then exits nonzero is now recorded as a change.** The autofix and formatter paths compare the bytes, not the exit code, so the rewritten file is refreshed and resynced to the language server. `ast_grep_replace`, language-server workspace edits and `lens_diagnostic_mark` now refuse files outside the session's writable roots, join the host's file queue, and record the files an interrupted `ast_grep_replace` already rewrote. (refs #5417)
