---
section: Fixed
audience: user
---

- **PowerShell scripts with a UTF-8 BOM no longer get false syntax errors.** PowerShell Editor Services reported them because pi-lens sent the file's leading U+FEFF to the server as document text, which the server parses as a token. It now sends one space in its place, so every column and line ending stays where it is, and the file on disk is not touched. Other language servers receive the text as before. (refs #5151)
