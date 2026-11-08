---
section: Fixed
audience: user
area: runners
---

- **A fixer that rewrites a file and then exits nonzero is now recorded as a change.** The autofix and formatter paths compare the bytes, not the exit code, so the rewritten file is refreshed and resynced to the language server. `ast_grep_replace`, language-server workspace edits and `lens_diagnostic_mark` refuse files outside the session's writable roots and record the files an interrupted `ast_grep_replace` already rewrote. Under `no-autofix`, `ast_grep_replace` previews but refuses `apply: true`, and a language-server rename that touches a vendor path such as `node_modules` is refused whole. (refs #5417)
