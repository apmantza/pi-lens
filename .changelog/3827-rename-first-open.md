---
section: Fixed
---

- **`lsp_navigation rename` no longer refuses a file the language client first opened after the rename was computed (closes #3827)** — A read or cascade touch that opened a not-yet-open file after the server answered made the staleness check report "it changed after the language server computed the rename" although no byte changed. The client now records when it first sent a file and when it started. A file first opened after the request that no one wrote since the client started is held to the unopened-file rule (mtime against the request) instead of its first send's stamp, and is still refused when its bytes changed after that first open. A file open at the request, or one written since the client started, is still refused, so a pi write whose sync lands as that first open cannot take the server's offsets.
