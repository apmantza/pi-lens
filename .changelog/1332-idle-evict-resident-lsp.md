---
section: Changed
---

- **Idle pyright, marksman and opengrep servers release their memory (refs #1332)** — The TypeScript idle eviction now also covers the Python, Markdown and opengrep language servers, which previously stayed resident for the whole session. They share the same timer and 20-minute default (`PI_LENS_TS_IDLE_EVICT_MS`) and respawn transparently on the next request.
