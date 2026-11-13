---
section: Fixed
audience: internal
---

- The pre-push gate's default temp root moves from `~/.pi-lens/prepush-tmp` to `~/.local/share/pi-lens-prepush`, outside every path `isPiLensInternalPath` treats as pi-lens-owned, so fixtures built under `os.tmpdir()` are no longer dropped and the turn-scenarios gitleaks cell stops redding every push that selects it (refs #5536).
