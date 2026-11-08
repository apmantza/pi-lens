---
section: Fixed
audience: user
area: runners
---

- **Unreadable output and timeouts now read the same across linters.** A nonzero exit with output its parser cannot parse at all is a parse error for vale, SwiftLint, spellcheck, taplo and detekt, as it already was for ruff, and a nonzero prisma exit that printed nothing is a skip. A timeout in helm or clippy is a run that did not finish, as it is for SwiftLint. For vale, SwiftLint, spellcheck, taplo and detekt, a valid report that names only other files still reads clean. Ruff, credo and shellcheck no longer lose their findings to a warning printed on stderr, and opengrep reads a complete report whatever its exit status. (refs #5411)
