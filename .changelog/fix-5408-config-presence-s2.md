---
section: Fixed
audience: user
area: runners
---

- **A tool config above your home directory no longer counts as project config.** ESLint, Biome, golangci-lint, PHPStan, Stylelint, markdownlint, Vite+, Vale, ShellCheck and the Java build check now stop their config search at your home directory, and a `vite.config` that only mentions `vite-plus` in a comment no longer selects the Vite+ tools. ShellCheck also reads a `.shellcheckrc` beside the script. (refs #5408)
