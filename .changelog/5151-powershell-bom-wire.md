---
section: Fixed
audience: user
---

- **A PowerShell script saved as UTF-8 with a BOM no longer gets false syntax errors from PowerShell Editor Services.** pi-lens sent the file's leading U+FEFF to the server as document text, which the server parses as a token. It now sends one space in its place, so every column and line ending stays where it is, and the file on disk is not touched. Other language servers receive the text as before. (refs #5151)
