---
section: Fixed
---

- **Share language markers across runner cwd resolution (closes #2965, closes #2966, closes #2964)** — runner fallbacks use the language marker vocabulary, cwd resolution returns its anchoring marker, and one dispatch pass reuses only its `.git` fallback.
