---
section: Fixed
---

- **Heredoc bodies no longer leak into Bash command analysis (refs #2726)** — `tokenizeShellCommand` now consumes `<<` and `<<-` bodies, drops quoted body text, and retains substitutions from unquoted bodies so git-guard does not classify prose as an executable command.
