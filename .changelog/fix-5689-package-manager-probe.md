---
section: Security
audience: user
area: lsp
---

- **Global package-manager discovery gates probes by root admission.** Discovery scopes both the manager finder and the manager query, judges the root the caller scanned, refuses a manager or a global tool linked into that root, and keeps cached answers separate across execution contexts. A session started in your home directory without pi trust no longer runs global tools installed under it; trust the project in pi to use them. (refs #5689)
