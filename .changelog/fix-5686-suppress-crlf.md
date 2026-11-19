---
section: Fixed
audience: user
area: tools
---

- **Suppressing a diagnostic no longer rewrites a CRLF file's line endings.** The inline `pi-lens-ignore` comment takes the ending of the line it is inserted above, and every existing line ending is kept. (refs #5686)
