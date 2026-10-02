---
section: Added
audience: user
---

- Verify archive-installed language servers by a spawn-free manifest and add a managed Kotlin Language Server. Every `archive` tool now needs its download to match a pinned sha256 (keyed by URL, fail-closed on an unpinned URL) before extraction, a launcher must be non-empty and executable, and a launcher that needs `java` is `unavailable` before the 87 MB download instead of after; a `tree-manifest` entry is never spawn-probed with `--version`, and `kotlin-language-server` (fwcd 1.3.13) resolves through it as the Kotlin fallback when no `kotlin-lsp` or `kotlin-language-server` is on PATH (refs #3400).
