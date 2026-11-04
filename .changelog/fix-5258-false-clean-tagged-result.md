---
section: Fixed
audience: user
---

- **A write no check covered no longer reads `✓ … clean`.** The per-edit line and the footer said clean for a TypeScript file under `--no-lsp`, a `build.gradle`, a generated file and a file whose kind has no analyzer, because the clean line was the default of a missing field. Every producer of a dispatch result now states a required `verdict`, `checked` only from the runners that completed a full read, and an unchecked write names its reason (`⚠ … unconfirmed — <reason>`); a collect-later primary still running reads unconfirmed too, once per file per session. The footer counts only files a check could have covered: a kindless or generated file says so on its write line and never adds to `⚠ N unchecked` (refs #5258).
