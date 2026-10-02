---
section: Fixed
audience: user
---

- **Restore post-edit diagnostics for tools that spell the target `filePath` or `file_path` (refs #3650)** — The `tool_result` path now honors adapter-declared and alternate path spellings, so written-file tracking, deferred formatting, and post-mutation diagnostics no longer silently skip those edits.
