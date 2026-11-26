---
section: Security
audience: user
area: lsp
---

- **Global package-manager discovery gates probes by root admission.** Discovery scopes both the manager finder and the manager query, refuses executable links into a refused root, and keeps cached answers separate across execution contexts. (refs #5689)
