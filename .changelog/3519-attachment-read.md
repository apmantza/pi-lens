---
section: Fixed
audience: user
---

- **An edit at the line numbers of an attached autofix is no longer refused or moved onto other lines (closes #3519)** — after the turn's first `write`, pi-lens' autofix can rewrite the file and attach the result as "authoritative for subsequent edits", but the read guard still judged the agent's next edit against the bytes from before the fix. A one-line edit of the attached content was refused as "Edit range changed since read", and a two-line edit could be silently relocated onto different lines whenever the fix added or removed a line. The attached content is now recorded as the agent's read of the whole file, hashed from the attachment itself, so edits made from it are checked against what the agent was shown. When the attachment is withheld (too large, or over a multi-file write's budget) nothing is recorded, and the agent's own line numbers are judged as before.
