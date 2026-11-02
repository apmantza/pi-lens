---
section: Added
audience: user
---

- **Built-in Groovy language server row.** `.groovy`, `.gvy`, `.gy` and `.gsh` files get a `groovy` LSP row for `lens_diagnostics` (`source: "lsp"`) and `lsp_navigation`. groovy-language-server publishes no release, so nothing is downloaded: pi-lens runs a `groovy-language-server` launcher from `PATH`, else `java -jar` on the jar named by `GROOVY_LANGUAGE_SERVER_JAR` (build it with `./gradlew build`), on a JDK 17 or newer found the way the Java server finds one. The server publishes only for files with errors, so a file it stays silent for reads `inconclusive`, never clean; a held empty publish no longer erases an error it just reported. `.gradle` and `Jenkinsfile` stay out unless configured under `lsp.servers`. (#5123)
