---
section: Changed
---

- **One result renderer for pi tool results and the MCP mirror (refs #2800)** — result status, diagnostic severity and usage lines come from one shared renderer on both surfaces, pinned by a both-surfaces governance test that drives real inputs for every paired registry tool and explicitly covers pi-only rows.
  The renderer runs after each tool has set `isError`, then applies stale warnings, and bounds the final MCP payload to 40 KiB.
