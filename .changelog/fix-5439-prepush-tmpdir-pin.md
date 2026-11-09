---
section: Fixed
audience: internal
---

- The pre-push gate pins its own temp root instead of inheriting the caller's `TMPDIR`: `scripts/pre-push-targeted-tests.mjs` resolves `<PI_LENS_HOME or ~/.pi-lens>/prepush-tmp`, creates it, and points `TMPDIR`/`TEMP`/`TMP` there before any build, self-scan, selection, or test spawn, so macOS's long, symlinked `/private/var/folders/...` root can no longer red path-sensitive tests on the same commit that passes under a short real root. `PI_LENS_PREPUSH_TMPDIR` is the operator escape hatch, and the startup line records the resolved root and the caller's value (refs #5439).
