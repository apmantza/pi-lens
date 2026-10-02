---
section: Fixed
audience: internal
---

- **The Bash guard hook now denies a git hook bypass (closes #3778)** — `git commit`/`push`/`merge`/`rebase` with `--no-verify` (or `-n` on commit), a `-c core.hooksPath=` override, a `git config core.hooksPath` write, or a `HUSKY=0` / `PI_LENS_SKIP_HOOKS=` prefix is refused with a one-line message naming `scripts/red-on-base.mjs`; heredoc, quoted PR-body and `--body-file` text that merely mentions the flag stays allowed.
