---
section: Fixed
audience: user
---

- **A fixed or deleted file's blocker leaves the session listing and the footer (refs #5020)** — a chart-wide or import-following runner (helm-lint, helm-render, mypy, phpstan, cue-vet) reports a row for a file it was not dispatched for, and the widget store lists it under the file you wrote. The commit gate already retired its copy of that row (#5033); the widget's copy stayed until the written file was next edited. The row now records the file it cites and leaves with the gate's, at the same point. Rows persisted by an older build have no cite and are kept.
