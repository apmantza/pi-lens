---
section: Fixed
---

- **Test-runner selection is per file kind and per module root, and a go `[setup failed]` result is advisory (refs #2870)** — a repo carrying both a `go.mod` and a Gradle build no longer hands every `.java` file to `go test` (the `RUNNERS` declaration order used to decide), a `README.md` or `.yaml` under a test directory no longer becomes its own test target, a nested Gradle or Go module anchors at its own build while a single-language repo keeps the runner it selected before, and go's `FAIL <pkg> [setup failed]` verdict reports as "could not run tests" instead of a fabricated blocking failure whose classification depended on whether go printed the word "error".
