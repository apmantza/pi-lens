---
section: Fixed
audience: user
area: runners
---

- **Linters now report unreadable output and timeouts the same way in every runner.** A nonzero exit with output no parser can read is a parse error for vale, SwiftLint, spellcheck, taplo, detekt and prisma, as it already was for ruff. A timeout in helm or clippy is a run that did not finish, as it is for SwiftLint. Ruff, rubocop, credo and shellcheck no longer lose their findings to a warning printed on stderr, and opengrep reads a complete report whatever its exit status. (refs #5411)
