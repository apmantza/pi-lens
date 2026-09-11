---
section: Fixed
---

- **Remove test scratch directories on exit (refs #2912)** — shared Vitest setup records each fixture root's owning test, removes only that test's roots after deferred work drains, and removes remaining `describe`/`beforeAll` roots at file teardown. The serialized hygiene owner removes newly-created unadmitted `pi-lens-*` fixtures, the MCP harness removes IPC endpoints after child exit, release-QA accepts an owned `--scratch-root` with signal cleanup, ast-grep baseline scratch is bounded, and generated ast-grep scan directories are collision-proof and cleanup-safe on partial setup failure.
