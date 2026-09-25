---
section: Changed
---

- The npm package no longer ships the extension twice. The three command-line entries, the MCP analysis worker and the two background persist workers are now bundled like the main entry, sharing code chunks, and the unbundled `dist/clients/` and `dist/tools/` trees are no longer published: about 4.4 MB less unpacked and 360 fewer files (refs #3219).
