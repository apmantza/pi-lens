---
section: Added
audience: user
area: config
---

- **A tool you know never writes can now skip the per-call tree comparison.** List its name under `opaqueScan.nonWriterTools` in `~/.pi-lens/config.json`, or in a project `.pi-lens.json` that pi trusts, and pi-lens stops running two `git status` checks around each call. No tool is listed by default, shells and pi-lens tools are never exempted, and a refused entry is reported once per session. (refs #5793)
