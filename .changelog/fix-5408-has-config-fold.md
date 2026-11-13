---
section: Changed
audience: user
area: runners
---

- **Kotlin formatter and Svelte config-file checks now stop at your home directory.** A `.ktfmt` file, a Spotless block or an `oxfmt.toml` above `$HOME` no longer selects ktfmt, ktlint or oxfmt for `.svelte`. Helm, Trivy, golangci-lint, detekt and Java also check their binary once per working directory now, so a lint run and its autofix in the same directory no longer probe the same tool twice. (refs #5408, #5410)
