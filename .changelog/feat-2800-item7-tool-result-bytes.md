---
section: Added
---
- **Per-call tool-result observability**: the `usage tokens=<n> elapsed-ms=<n>` contract footer gains `bytes=<delivered payload bytes> truncated=<true|false>` on both host surfaces, the payload byte bound runs before the footer is stamped with the footer's own maximum size reserved so the delivered text (footer included) never exceeds 40 KiB, and the per-turn `cache_usage` latency row aggregates `toolResultBytes` and `toolResultsTruncated` over the turn's tool calls (refs #2800)
