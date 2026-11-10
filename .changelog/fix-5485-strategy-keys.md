---
section: Fixed
audience: internal
---

- Delete two wait-strategy rows keyed by names no LSP server has (`rust-analyzer`, `eslint`), measure why rust must not be re-keyed as it was, and fail any strategy key that is not a registry id. (refs #5485)
