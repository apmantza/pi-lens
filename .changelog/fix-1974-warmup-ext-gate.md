---
section: Fixed
---

- **Fix 30s+ background warmup on repos with large ignored non-source dirs (closes #1974)** — the quick-mode warmup language-profile walk ran the expensive ignore matcher (fresh minimatch regex compile per unique path) on every file BEFORE its cheap extension gate, so a runtime-output pile like `wal/*.log` (43k ignored files) cost ~30s of pure waste. The extension gate now runs first; the walk is output-identical and measured 22x faster on the reproducing repo. The same ordering fix applies to the jscpd, source-filter, and startup-scan walks.
