---
section: Fixed
---

- A language server that crashes or is evicted between two touches of the
  same content no longer leaves its replacement without the file. The touch
  debounce now applies only to the client instance that received the write,
  so the respawned server is sent the document. Before, marksman and lua
  could report a file "confirmed" clean that the new server had never seen,
  and other servers waited out their budget and ended inconclusive
  (closes #3501).
