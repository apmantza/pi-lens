---
section: Fixed
audience: internal
---

- The nightly clean-signal probe no longer credits a fixture's row to a different launch: a `typescript7` row that ran the classic server now reads `unknown` instead of `mode=push-only`, the probe rewrites the tracked LSP capability matrix only with `--write-matrix`, and the comments and matrix prose no longer say native TS7 is silent on clean (it is a pull server) (refs #5348).
