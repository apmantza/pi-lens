---
section: Fixed
audience: user
area: lsp
---

- **A language-server edit keeps the line ending of the edited line.** In a file with mixed line endings, new lines inserted by a rename or code action took the file's first line ending, so a CRLF line in an LF-first file got a bare LF (and the reverse). Files with one line-ending style are unchanged. (refs #5670)
