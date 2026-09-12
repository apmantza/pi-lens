---
section: Fixed
---

- **Remove test scratch directories on exit (refs #2912)** — the generic process-wide fixture sweep was attempted twice and reverted after broad suite breakage; proven per-family sweeps remain, and unresolved prefixes enter an environment-independent prefix-set ratchet with named producers. The serialized hygiene owner records and removes newly-created `pi-lens-*` fixtures, the MCP harness removes IPC endpoints after child exit, release-QA accepts an owned `--scratch-root` with signal cleanup, ast-grep baseline scratch is bounded, generated ast-grep scan directories are collision-proof with preparation cleanup on partial setup failure, and agent-end summary fixtures drain several macrotasks before cleanup.
