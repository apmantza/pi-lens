---
section: Fixed
---

- **Remove test scratch directories on exit (refs #2912)** — the generic process-wide fixture sweep was attempted twice and reverted after broad suite breakage; proven per-family sweeps remain, and unresolved prefixes enter a shrink-only hygiene ratchet with named producers. The serialized hygiene owner removes newly-created unadmitted `pi-lens-*` fixtures, the MCP harness removes IPC endpoints after child exit, release-QA accepts an owned `--scratch-root` with signal cleanup, ast-grep baseline scratch is bounded, and generated ast-grep scan directories are collision-proof and cleanup-safe on partial setup failure.
