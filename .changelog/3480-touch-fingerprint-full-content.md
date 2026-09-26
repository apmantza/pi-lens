---
section: Fixed
---

- **A same-length edit in the middle of a long file now reaches the language server (closes #3480)** — the touch debounce and the drift sweep's confirmation read fingerprinted a file longer than 96 characters by its length and its first and last 48 characters. An edit that kept the length and changed only the middle, such as `x = 1` to `x = 2`, was skipped when it came within 1.5 s of the previous touch, and the sweep then marked it unchanged, so the server kept reporting diagnostics for the old content. Both now hash the whole text.
