---
section: Fixed
audience: user
area: lsp
---

- **An unknown id in `lsp.disabledServers` is reported and dropped.** A misspelled server id used to stay in the deny list with no notice and match no server. pi-lens now prints one `PILENS_CFG_0005` notice per unknown id. (refs #5139)
