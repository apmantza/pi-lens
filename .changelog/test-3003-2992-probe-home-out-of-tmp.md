---
section: Fixed
---

- **Keep the #2992 regression probe out of system temp (refs #2912)** — the read-bridge lifecycle test stores its ledger home under the ignored worktree-local `.probe-home` directory, so asynchronous bookkeeping cannot recreate a leaked top-level `/tmp` fixture.
