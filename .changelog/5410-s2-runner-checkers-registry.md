---
section: Fixed
audience: user
area: runners
---

- **A project's own `shellcheck` in `node_modules/.bin` is now found.** The shellcheck, shfmt, tflint, terragrunt, cue-vet and spellcheck runners each kept a private tool check that looked in the project's venv and nowhere else. They now use the one lookup every other runner uses, so a trusted project's npm-installed `shellcheck` runs, and a skip names the cause the lookup found. Which tools pi-lens installs on its own does not change. (refs #5410)
