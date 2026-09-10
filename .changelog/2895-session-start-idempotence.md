---
section: Fixed
---

- **Deduplicate repeated RPC session starts (refs #2890)** — use the stable session ID, fall back to the session file, and re-run the restore when the host's active tool posture drifted.
