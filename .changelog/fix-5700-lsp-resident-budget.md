---
section: Fixed
audience: user
area: lsp
---

- **Language servers close old files and stop when a session goes idle.** Each client keeps at most 256 documents open (`PI_LENS_LSP_OPEN_DOCUMENT_CAP`) and closes the least recently sent one with `didClose`. A closed file's last findings stay readable, marked `closed: true` in the `lsp_navigation` workspace snapshot, and the next touch opens it again. Every server not declared `resident` is now released after the idle window on the pi host and the MCP host. Before, 32 servers, including every server a project declares, were never released. Only five project indexers (expert, kotlin, powershell, rust, svelte) stay resident. The pi host's session idle reset now restarts after a turn that edited files; before, such a turn cancelled it and nothing armed it again. (refs #5700)
