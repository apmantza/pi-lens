---
section: Fixed
audience: user
---

- **Scan-written widget findings go stale when their file changes mid-scan (closes #3573)** — findings that `lens_diagnostics mode=full`, `pilens_analyze` or an active cascade re-check wrote to the widget were stamped when the scan finished, not when it read the file. A file, or a file it imports, edited while the scan was still running therefore looked older than the finding, so the finding stayed authoritative until the next edit. Each writer now stamps its findings at the read: the workspace sweep's per-file read time is kept through the `mode=full` commit, `pilens_analyze` stamps before its language-server warm-up, and the cascade stamps before it reads the dependent file. A fresh cheap-tier project scan is now checked against the bytes it read before its findings reach the widget, as a cached one already was.
