---
section: Fixed
---

- **PHP LSP (intelephense) now installs (closes #2722)** — the managed installer verified every npm tool by spawning `--version`, and intelephense has no CLI: it prints ~4 MB of bundled source before the "connection input stream is not set" line that proves it is a healthy stdio server, and Node drops everything past 1 MiB of a piped stderr, so that proof never reached pi-lens and the installer deleted the package it had just installed — every time, since 2026-04-17. A managed npm server can now declare that it is verified from the installed tree instead (package manifest + entry module on disk, no spawn at all), which intelephense does; and for every tool still verified by spawning, a probe that ran out of readable output before it could decide now KEEPS the installation for a later re-probe instead of treating "cannot tell" as "broken".
