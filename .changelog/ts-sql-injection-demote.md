---
section: Changed
---

- **`sql-injection` (TypeScript tree-sitter rule) is a warning, not a blocking error.** The query keys on the callee name only (`query|execute|exec|run`), so any template literal passed to a same-named non-SQL function fired a blocking finding; it stays as a warning until the rule gains a receiver/type signal.
