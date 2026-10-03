---
section: Fixed
audience: internal
---

- guard-bash now applies every git rule behind a shell keyword and behind a
  git global option that takes a separate value. `for … do git push
  --no-verify`, `if … then git stash` and `! git reset --hard` were allowed
  because `do`, `then`, `else`, `elif`, `if`, `while`, `until`, `!` and
  `coproc` were not skipped before the command word. `git --git-dir x stash`
  and `git --config-env core.hooksPath=H commit` were misread because
  `--git-dir`, `--work-tree`, `--namespace`, `--config-env` and
  `--attr-source` were not skipped with their value. `sh -c`, `eval`,
  `xargs`, `nice`/`timeout`/`env -i` prefixes and `GIT_CONFIG_KEY_*` stay
  documented as not handled (closes #3787).
