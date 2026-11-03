---
section: Fixed
audience: internal
---

- Sixty-five scripts decided "am I the entry module?" with a private copy of the gate that compared the module URL with the symlink-preserving `process.argv[1]`, so a script started through a linked path exited 0 without running: `check-changelog-fragments`, `check-pr-body` and `ci-verdict` passed without checking, and the `guard-bash` hook allowed `git stash`. They now call `isMainModule` (the `guard-bash` hook keeps a standalone realpath gate, because the probe loads it from a git ref), and `tests/config/script-entry-portability.test.ts` refuses any new private gate. (refs #4096)
