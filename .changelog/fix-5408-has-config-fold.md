---
section: Changed
audience: user
area: runners
---

- **Kotlin formatter and Svelte config checks now stop at your home directory.** A `.ktfmt` file, a Spotless block or an `oxfmt.toml` above `$HOME` no longer selects ktfmt, ktlint or oxfmt for `.svelte`. Helm, Trivy, golangci-lint, detekt and Java also check their binary once per project now, so a lint run and its autofix no longer probe the same tool twice. (refs #5408, #5410)
