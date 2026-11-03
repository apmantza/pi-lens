---
section: Fixed
audience: user
---

- **Keep unsupported shell dialects out of the Bash LSP.** Files named `.sh` or `.bash` now use the same shebang and `shellcheck shell=` dialect decision as the CLI runner, so zsh files no longer reach the Bash language server (follow-up to #3969).
