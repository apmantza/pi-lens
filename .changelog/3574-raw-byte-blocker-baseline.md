---
section: Fixed
audience: user
---

- **Blockers on non-UTF-8 files no longer go stale on their own (closes #3574)** — the content baseline for an inline blocker was taken from the file's text after UTF-8 decoding. For a file holding bytes that are not valid UTF-8, such as a Latin-1 file, that baseline never matched the file on disk, so a blocker from a non-language-server tool was demoted as changed at every turn end without any edit. The baseline is now the raw bytes read from disk, so an unchanged file keeps its blocker and an edited one is still demoted, including an edit that decodes to the same text.
