---
section: Fixed
audience: user
area: runners
---

- **A Gradle edit that keeps its timestamp now changes the Kotlin formatter pi-lens picks.** The Spotless check in `build.gradle(.kts)` remembered its answer by modification time alone, so a rewrite that kept the time (a copy that preserves times, an archive extract) and changed the length still read as the old `ktlint` or `ktfmt` choice. It now compares the length too, like every other config cache. (refs #4907)
