---
section: Fixed
audience: user
---

- **Ast-grep fallbacks use the official CLI package from an isolated cwd (#4193)** — Structural rule replacements, path searches, and CLI probes name `@ast-grep/cli` when direct binary resolution fails and run from a pi-lens-owned tools directory, so a project's `.npmrc` never reaches `npx`; relative `paths` resolve against the project before dispatch.
