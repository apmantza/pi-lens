---
section: Fixed
audience: user
area: tools
---

- **Suppressing a diagnostic no longer rewrites a CRLF file's line endings.** The inline `pi-lens-ignore` comment takes the ending of the line it is inserted above, every existing line ending is kept, and a whitespace-only CRLF line no longer lends its bare `\r` to the inserted comment's indentation. (refs #5686)
