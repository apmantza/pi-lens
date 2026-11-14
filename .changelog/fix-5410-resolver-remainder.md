---
section: Fixed
audience: user
area: runners
---

- **Rubocop, SpotBugs and the Java server share one tool ladder.** A Gemfile that names rubocop on a host without bundler no longer skips the runner while a working rubocop is on PATH, and a `java` on PATH that cannot run (the macOS stub with no JDK behind it) no longer hides the JDK pi-lens found, so jdtls starts. Each binary is probed once and its verdict is shared. (refs #5410)
