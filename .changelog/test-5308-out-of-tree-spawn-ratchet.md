---
section: Added
audience: internal
---

- **The run-outcome ratchet now audits `scripts/` and `clients/lsp/`.** A file under either root that starts a child process either routes through `classifyRunOutcome`, or carries a baseline row spelling out how a failed child reaches it (it throws, or it reads `status`/`exitCode`/`signal`/`killed`/`error`); the census follows a spawn that arrives through an import alias, an injected default, a namespace member, or a hand-off, and reports a `require`, a dynamic `import()`, or a re-export it cannot open instead of skipping it. 77 files with 152 spawn sites carry a row today. (refs #5308)
