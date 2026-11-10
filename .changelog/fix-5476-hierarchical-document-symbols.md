---
section: Fixed
audience: user
area: lsp
---

- **ElixirLS document symbol requests no longer fail on an omitted capability.** The client explicitly declares support for hierarchical document symbols while continuing to accept flat responses. Definition fallback uses the symbol name range so navigation and search-read coverage do not include the whole body. (refs #5476)
