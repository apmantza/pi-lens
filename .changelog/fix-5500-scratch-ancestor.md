---
section: Fixed
audience: user
area: security
---

- **A project under a scratch-named parent directory now keeps its scan results.** A checkout under `.claude/worktrees/<lane>` or a `.pi-lens` temp root had every gitleaks finding dropped or demoted, so the turn-end secrets blocker never fired. Opengrep and vulture also skipped the whole project there. Scratch directories are now judged below the project root only, and a gitleaks or trivy scan of a symlinked project root now scans the real directory instead of reporting nothing. (refs #5500)
