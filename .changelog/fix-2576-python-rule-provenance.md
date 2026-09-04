---
section: Fixed
---

- **Require structural provenance for Python SQL-rule suppressions (fixes #2576)** — valid SQLAlchemy imports and `select()` calls no longer receive unrelated diagnostics. `Session.query` and psycopg identifier composition are suppressed only when same-file AST evidence proves the safe API. Raw, dynamic, shadowed, and ambiguous SQL remains diagnostic.
