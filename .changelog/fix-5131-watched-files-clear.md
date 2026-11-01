---
section: Fixed
audience: user
---

- **A custom server that recompiles on pi-lens's own file notice can no longer wipe a real error**: when a version-less `lsp.servers` server (groovy-language-server) published an error for a freshly opened file and then an empty set right after the `workspace/didChangeWatchedFiles` pi-lens sends for that file, the file read clean; that one empty publish is now held and the error stays, and a later edit still earns its own clean. Built-in servers are unchanged (#5131).
