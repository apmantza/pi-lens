---
section: Changed
audience: user
area: lsp
---

- **Language server root lookup now checks each folder's markers together.** A
  lookup waits on marker files once per folder instead of once per file, so a
  slow filesystem call is paid fewer times. Marker precedence is unchanged.
  (refs #5814)
