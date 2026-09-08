---
section: Changed
---
- **Dropped a no-op string replacement in the tsgolint preflight test (refs #2709)** — CodeQL alert 49 (`js/identity-replacement`): the helper replaced `/package.json` with itself; the key lookup now only strips the `/tmp/` prefix.
