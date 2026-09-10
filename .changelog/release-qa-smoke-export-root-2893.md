---
section: Fixed
---

- **Run the release-QA tool smoke from the export root (closes #2893)** — the install lane now executes the smoke harness from the archived source tree while loading the installer registry from the installed package, and measures pip entries under its scratch-pinned package policy.
