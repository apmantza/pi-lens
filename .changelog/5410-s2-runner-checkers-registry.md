---
section: Fixed
audience: user
area: runners
---

- **A project's own `shellcheck` in `node_modules/.bin` is now found.** The shellcheck, shfmt, tflint, terragrunt, cue-vet and spellcheck runners each kept a private tool check. Each looked in the project's venv and nowhere else. They now use the one lookup every other runner uses. In a trusted project, a `node_modules/.bin` copy now wins over PATH. On Windows, `.cmd` and `.exe` resolve per directory. Which tools pi-lens installs on its own does not change. (refs #5410)
