---
section: Changed
audience: user
area: runners
---

- **Formatter and linter config checks now stop at your home directory.** A `.clang-format`, `.oxlintrc.json`, `.prettierrc` or similar file above `$HOME` no longer selects its tool, and a commented or look-alike gem in a Gemfile no longer selects rubocop or standardrb. (refs #5408)
