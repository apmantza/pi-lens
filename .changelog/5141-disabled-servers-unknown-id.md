---
section: Fixed
audience: user
---

- **An unknown id in `lsp.disabledServers` is reported and dropped.** A misspelled server id used to stay in the deny list with no notice and match no server, so a server you meant to turn off kept running. pi-lens now prints one `PILENS_CFG_0005` notice per unknown id, as `dispatch.disabledRunners` already does. Built-in server ids and servers declared under `lsp.servers` stay valid. (refs #5141)
