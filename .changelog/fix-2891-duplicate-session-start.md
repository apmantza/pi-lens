---
section: Fixed
audience: user
---

- **Duplicate pi session starts are ignored safely.** pi-lens now drops repeated `session_start` events at entry while preserving distinct reload, new, resume, and fork starts, and drains NDJSON logs before graceful shutdown (refs #2891).
