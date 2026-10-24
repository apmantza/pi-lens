---
section: Fixed
audience: user
---

- **pyright's interpreter now reaches the server; rust-analyzer's settings pull is answered truthfully** — pi-lens answered every `workspace/configuration` request from one flat options blob. pyright reads neither `pythonPath` nor `openFilesOnly` from `initializationOptions`; it pulls the `python`, `python.analysis` and `pyright` sections, got `{}` for each, and ran on its defaults, so the detected project interpreter and any `lsp.serverOverrides` options for pyright never reached it. They now sit under `python.pythonPath` and `python.analysis.diagnosticMode`, and a real pyright resolves a package that only the project interpreter carries. rust-analyzer already received its options at startup through `initializationOptions`, and it skips an empty client config, so the `{}` it pulled was a no-op; that pull is now answered with the same blob (user overrides included) so the two paths agree, and its applied effect stays unmeasured. Overrides for pyright and basedpyright are written under their section names (for example `python.analysis.typeCheckingMode`); see `docs/configuration.md`.
