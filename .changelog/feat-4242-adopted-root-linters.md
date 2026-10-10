---
section: Added
audience: user
---

- **Adopted out-of-root projects now get global, config-free per-file linters** — when an edit lands in a marked project outside the session root, pi-lens admits only the explicit admission list of dispatch runners that read no project config and cannot execute project code (`php-lint`, `fish-indent`), and only from global or pi-lens-managed binaries; the advisory now says the LSP plus these per-file linters run. Executable paths inside the adopted or session root are refused, including PATH entries and symlink targets. Formatting, autofix, other dispatch runners, whole-project scanners, and automatic tests stay off (refs #4242).
