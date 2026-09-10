---
section: Fixed
---

- **`detectFileRole` recognises Go `_test.go` and the other table conventions (closes #2880)** — Editing `pkg/foo_test.go` produced no test target because the shared role classifier only knew `.test.`/`.spec.`/prefix/dir patterns. It now also matches the `_test.`/`_spec.` suffix infixes and the case-sensitive `*Test(s).<ext>` CamelCase suffix for Java/Kotlin/C#/F#/PHP, informed by the test-runner client's `SOURCE_TO_TEST_PATTERNS` + `RUNNERS` table; hand-written, see #2928 for the single-classifier fold, so an edited Go test file runs its own package tests.
