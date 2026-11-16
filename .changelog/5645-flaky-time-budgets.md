---
section: Fixed
audience: internal
---

- Stopped two required-lane test flakes: the tool-cwd language-root cell now runs under the lane-scaled timeout, and the `lsp_diagnostics` abort cell asserts the abort (not the per-file deadline) released the in-flight file from the outcome's reason instead of a 500 ms elapsed margin. (refs #5645)
