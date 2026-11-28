---
section: Changed
audience: user
area: lsp
---

- **Language server root lookup now checks each folder's markers together.** A
  slow filesystem is waited on fewer times, because markers are probed up to
  Node's file thread-pool width (4 by default) at once. Marker precedence is
  unchanged. TypeScript extension and agent-folder lookups now log a marker
  skipped on a permission error. (refs #5814)
