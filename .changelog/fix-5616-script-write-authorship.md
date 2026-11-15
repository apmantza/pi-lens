---
section: Fixed
audience: user
area: blockers
---

- **A file your script wrote now gets its blockers like an edit does.** When a bash command such as `python3 fix.py` changes a file that was clean before it, and nothing else pi-lens saw wrote that file meanwhile, the blockers show as a STOP and the commit gate holds them; pi-lens does not reformat or autofix that file. When pi-lens cannot tell (the file was already modified, another write touched it, or the command failed), the line it shows now names each blocker's line and rule, says the file changed during the command, and asks you to fix them if your command wrote it. (refs #5616)
