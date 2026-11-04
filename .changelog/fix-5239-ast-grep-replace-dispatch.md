---
section: Fixed
audience: user
---

- **An applied `ast_grep_replace` is now checked like an `edit`.** The files it rewrites go through dispatch, so a blocker the rewrite introduces reaches the turn-end check and `git commit` under `--lens-guard` refuses it (#5239).
