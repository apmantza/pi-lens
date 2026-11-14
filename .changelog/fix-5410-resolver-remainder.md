---
section: Fixed
audience: user
area: runners
---

- **Rubocop runs without bundler, and jdtls starts past a macOS `java` stub.** A Gemfile that names rubocop no longer skips the runner while a working rubocop is on PATH, and a `java` on PATH that cannot run (the macOS stub with no JDK behind it) no longer hides the JDK pi-lens found, so jdtls starts. KtFmt autofix and SpotBugs also find a binary in a project's `node_modules/.bin` now. (refs #5410)
