---
section: Fixed
audience: internal
---

- The pre-push gate pins its own temp root instead of inheriting the caller's `TMPDIR`: `scripts/pre-push-targeted-tests.mjs` resolves `<PI_LENS_HOME or ~/.pi-lens>/prepush-tmp`, creates a fresh real `run-*` directory for each run, removed after completion (including failure); interrupts first terminate and drain the owned wrapper and Vitest tree, and a drain timeout preserves the original directory with a warning, and points `TMPDIR`/`TEMP`/`TMP` there before any build, self-scan, selection, or test spawn, so macOS's long, symlinked `/private/var/folders/...` root can no longer red path-sensitive tests on the same commit that passes under a short real root. Allocation uses the existing scratch owner seam rather than a special hygiene admission. `PI_LENS_PREPUSH_TMPDIR` is the operator escape hatch, and the startup line records the resolved root and the caller's value (refs #5439). At startup the pre-push gate removes stale `run-*` directories left by detached late writers, preserves live scratch owners, and skips unsafe entries with one degradation line (refs #5439).
