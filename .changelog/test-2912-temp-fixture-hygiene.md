---
section: Fixed
---

- **Remove test scratch directories on exit (refs #2912)** — the serialized hygiene owner removes newly-created unadmitted `pi-lens-*` fixtures, the MCP harness removes IPC endpoints after child exit, release-QA accepts an owned `--scratch-root` with signal cleanup, and ast-grep baseline scratch is bounded.
