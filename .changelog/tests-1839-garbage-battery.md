---
section: Added
---

- **Adversarial garbage battery for every CLI lint runner (closes #1839)** — Twenty runners now meet a 12-case battery of hostile outputs (truncated JSON, usage prose on the findings stream, unknown severities, hostile numbers) under format-blind invariants: never crash, never emit malformed diagnostics, never report clean on a nonzero exit carrying bytes. The first pass found 79 violations of that last invariant across 14 runners — all fixed by consolidating their identical tails onto one shared `finishParsedRun` seam. Also fixes htmlhint's `--rules` flag being fed JSON (the tool wants a ruleid list), which left zero rules enabled so every file read clean.
